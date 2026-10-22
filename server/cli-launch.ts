import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { win32 } from "node:path";

export interface CliLaunch {
  file: string;
  args: string[];
  /** Set for cmd.exe, whose command line is already quoted. */
  windowsVerbatimArguments?: boolean;
}

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/** Windows keeps environment names case-insensitive (`Path`); a copied env object does not. */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : env[key] || undefined;
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

/** Finds the file Windows would start for `command`, trying each PATHEXT suffix like cmd.exe does. */
function resolveWindows(command: string, env: NodeJS.ProcessEnv, exists: (path: string) => boolean): string | null {
  const extensions = (envValue(env, "PATHEXT") ?? DEFAULT_PATHEXT).split(";").filter(Boolean);
  const lower = command.toLowerCase();
  // An npm prefix also holds an extensionless POSIX script next to the `.cmd`; never pick it.
  const names = extensions.some((extension) => lower.endsWith(extension.toLowerCase()))
    ? [command] : extensions.map((extension) => command + extension.toLowerCase());
  const directories = /[\\/]/.test(command) ? [""] : (envValue(env, "PATH") ?? "").split(";").filter(Boolean);
  for (const directory of directories) {
    for (const name of names) {
      const path = directory ? win32.join(directory, name) : name;
      if (exists(path)) return path;
    }
  }
  return null;
}

/**
 * How to start a provider CLI without a shell. On Windows, npm installs CLIs as `.cmd` shims,
 * which Node starts only through cmd.exe, so the shim's path is quoted into a cmd.exe command
 * line. Elsewhere the command runs as given.
 */
export function cliLaunch(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = isFile,
): CliLaunch {
  if (platform !== "win32") return { file: command, args };
  const resolved = resolveWindows(command, env, exists);
  if (!resolved || !/\.(cmd|bat)$/i.test(resolved)) return { file: resolved ?? command, args };
  // Inside quotes cmd.exe still expands %VAR%, and a quote would end the path early.
  if (/["%]/.test(resolved) || args.some((arg) => !/^[\w.-]+$/.test(arg))) {
    throw new Error("The CLI path cannot be passed to cmd.exe safely");
  }
  return {
    file: envValue(env, "COMSPEC") ?? "cmd.exe",
    // /s strips the outer quotes, leaving `"<shim>" args`; /d skips AutoRun commands.
    args: ["/d", "/s", "/c", `""${resolved}" ${args.join(" ")}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * Ends a started CLI. On Windows a shim run through cmd.exe starts node and the CLI beneath it,
 * and killing cmd.exe alone leaves them running, so the whole tree is ended and awaited.
 */
export function stopProcessTree(child: ChildProcess, platform: NodeJS.Platform = process.platform): Promise<void> {
  // An exited process's ID may already belong to something else.
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  if (platform !== "win32" || child.pid === undefined) {
    child.kill();
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.on("error", () => { child.kill(); resolve(); });
    killer.on("exit", () => resolve());
  });
}

/** The home a CLI uses when nothing overrides it: the user profile on Windows, HOME elsewhere. */
export function cliHome(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  return (platform === "win32" ? envValue(env, "USERPROFILE") : env.HOME) || homedir();
}
