import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { win32 } from "node:path";
import type { Readable, Writable } from "node:stream";

export interface CliLaunch {
  file: string;
  args: string[];
  /** Set for cmd.exe, whose command line is already quoted. */
  windowsVerbatimArguments?: boolean;
}

export interface CliOptions {
  /** Where the CLI runs; a relative command path is resolved from here. */
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/**
 * On Windows a status server is given this long to exit after its input closes, so its shim tree
 * winds down as a whole before anything is ended by force.
 */
export const CLI_STOP_GRACE_MS = 2_000;

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/** Windows keeps environment names case-insensitive (`Path`); a copied env object does not. */
function envAnyCase(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : env[key] || undefined;
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

/** Finds the file Windows would start for `command`, trying each PATHEXT suffix like cmd.exe does. */
function resolveWindows(command: string, options: CliOptions, exists: (path: string) => boolean): string | null {
  const extensions = (envAnyCase(options.env, "PATHEXT") ?? DEFAULT_PATHEXT).split(";").filter(Boolean);
  const lower = command.toLowerCase();
  // An npm prefix also holds an extensionless POSIX script next to the `.cmd`; never pick it.
  const names = extensions.some((extension) => lower.endsWith(extension.toLowerCase()))
    ? [command] : extensions.map((extension) => command + extension.toLowerCase());
  const directories = /[\\/]/.test(command)
    ? [win32.isAbsolute(command) ? "" : options.cwd]
    : (envAnyCase(options.env, "PATH") ?? "").split(";").filter(Boolean);
  for (const directory of directories) {
    for (const name of names) {
      const path = directory ? win32.resolve(directory, name) : name;
      if (exists(path)) return path;
    }
  }
  return null;
}

/** A `.cmd`/`.bat` launcher whose path or arguments cmd.exe would reinterpret, so it is not started. */
export class UnsafeShimError extends Error {
  constructor() { super("The CLI path cannot be passed to cmd.exe safely"); }
}

/**
 * How to start a provider CLI without a shell. On Windows, npm installs CLIs as `.cmd` shims,
 * which Node starts only through cmd.exe, so the shim's path is quoted into a cmd.exe command
 * line. Elsewhere the command runs as given.
 */
export function cliLaunch(
  command: string,
  args: string[],
  options: CliOptions & { platform?: NodeJS.Platform; exists?: (path: string) => boolean },
): CliLaunch {
  if ((options.platform ?? process.platform) !== "win32") return { file: command, args };
  const resolved = resolveWindows(command, options, options.exists ?? isFile);
  if (!resolved || !/\.(cmd|bat)$/i.test(resolved)) return { file: resolved ?? command, args };
  // Inside quotes cmd.exe still expands %VAR%, and a quote would end the path early.
  if (/["%]/.test(resolved) || args.some((arg) => !/^[\w.-]+$/.test(arg))) {
    throw new UnsafeShimError();
  }
  return {
    file: envAnyCase(options.env, "COMSPEC") ?? "cmd.exe",
    // /d skips AutoRun commands, /v:off keeps `!` literal even where delayed expansion is on by
    // default, and /s strips the outer quotes, leaving `"<shim>" args`.
    args: ["/d", "/v:off", "/s", "/c", `""${resolved}" ${args.join(" ")}"`],
    windowsVerbatimArguments: true,
  };
}

/** Starts a provider CLI with piped input and output, however it is installed. */
export function spawnCli(command: string, args: string[], options: CliOptions): ChildProcessByStdio<Writable, Readable, null> {
  const launch = cliLaunch(command, args, options);
  return spawn(launch.file, launch.args, {
    cwd: options.cwd, env: options.env, windowsVerbatimArguments: launch.windowsVerbatimArguments,
    windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
  });
}

/**
 * Runs a CLI to completion and returns its output. A timeout or oversized output ends the whole
 * process tree before the call fails.
 */
export function runCli(command: string, args: string[], options: CliOptions & { timeoutMs: number; maxBytes: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnCli(command, args, options);
    let output = "", bytes = 0, settled = false;
    const settle = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!error) { resolve(output); return; }
      void stopProcessTree(child).then(() => reject(error));
    };
    const timer = setTimeout(() => settle(new Error("CLI timed out")), options.timeoutMs);
    child.stdin.end();
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > options.maxBytes) settle(new Error("CLI output too large"));
      else output += chunk;
    });
    child.on("error", (error) => settle(error));
    child.on("close", (code) => settle(code === 0 ? null : new Error(`CLI exited with ${code}`)));
  });
}

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

/**
 * Ends a started CLI. On Windows a shim run through cmd.exe starts node and the CLI beneath it,
 * and killing cmd.exe alone leaves them running, so the CLI first gets up to `graceMs` to exit on
 * its own and is then ended with its whole tree. Elsewhere it is ended at once, as before.
 */
export async function stopProcessTree(
  child: ChildProcess,
  options: { graceMs?: number; platform?: NodeJS.Platform } = {},
): Promise<void> {
  const windows = (options.platform ?? process.platform) === "win32";
  // cmd.exe exits only after the shim and the CLI it waits on have exited.
  if (windows && options.graceMs && !exited(child)) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, options.graceMs);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
  // An exited process's ID may already belong to something else.
  if (exited(child)) return;
  if (!windows || child.pid === undefined) {
    child.kill();
    return;
  }
  await new Promise<void>((resolve) => {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.on("error", () => { child.kill(); resolve(); });
    killer.on("exit", () => resolve());
  });
}

/** The home a CLI uses when nothing overrides it: the user profile on Windows, HOME elsewhere. */
export function cliHome(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  return (platform === "win32" ? envAnyCase(env, "USERPROFILE") : env.HOME) || homedir();
}
