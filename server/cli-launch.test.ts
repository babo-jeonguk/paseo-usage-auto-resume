import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { cliHome, cliLaunch, runCli, spawnCli, stopProcessTree } from "./cli-launch";

const files = (...paths: string[]) => (path: string) => paths.map((entry) => entry.toLowerCase()).includes(path.toLowerCase());
const windowsEnv = { Path: "C:\\Windows\\system32;C:\\npm\\prefix;C:\\Users\\me\\.local\\bin", PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: "C:\\Windows\\system32\\cmd.exe" };
const onWindows = (exists: (path: string) => boolean, env: NodeJS.ProcessEnv = windowsEnv, cwd = "C:\\work") =>
  ({ env, cwd, platform: "win32" as const, exists });
const npmShim = files("C:\\npm\\prefix\\claude", "C:\\npm\\prefix\\claude.cmd");
const cmdLine = (launch: { args: string[] }) => launch.args.at(-1);

test("other platforms start the command as given", () => {
  assert.deepEqual(cliLaunch("claude", ["auth", "status", "--json"], { env: { PATH: "/usr/bin" }, cwd: "/work", platform: "linux", exists: () => assert.fail("no lookup") }),
    { file: "claude", args: ["auth", "status", "--json"] });
  assert.deepEqual(cliLaunch("/opt/codex", ["app-server", "--stdio"], { env: {}, cwd: "/work", platform: "darwin" }), { file: "/opt/codex", args: ["app-server", "--stdio"] });
});

test("a Windows npm shim runs through cmd.exe with its path quoted and expansion of ! turned off", () => {
  assert.deepEqual(cliLaunch("claude", ["auth", "status", "--json"], onWindows(npmShim)), {
    file: "C:\\Windows\\system32\\cmd.exe",
    args: ["/d", "/v:off", "/s", "/c", '""C:\\npm\\prefix\\claude.cmd" auth status --json"'],
    windowsVerbatimArguments: true,
  });
});

test("the extensionless POSIX script beside an npm shim is never chosen", () => {
  assert.equal(cmdLine(cliLaunch("C:\\npm\\prefix\\claude", ["--version"], onWindows(npmShim))), '""C:\\npm\\prefix\\claude.cmd" --version"');
});

test("a native executable starts directly, in PATH and then PATHEXT order", () => {
  const both = files("C:\\npm\\prefix\\claude.cmd", "C:\\Users\\me\\.local\\bin\\claude.exe", "C:\\npm\\prefix\\claude.exe");
  assert.deepEqual(cliLaunch("claude", ["--version"], onWindows(both)), { file: "C:\\npm\\prefix\\claude.exe", args: ["--version"] });
  const native = files("C:\\Users\\me\\.local\\bin\\claude.exe");
  assert.deepEqual(cliLaunch("claude", ["--version"], onWindows(native)), { file: "C:\\Users\\me\\.local\\bin\\claude.exe", args: ["--version"] });
  assert.deepEqual(cliLaunch("C:\\tools\\codex.exe", ["--version"], onWindows(files("C:\\tools\\codex.exe"))),
    { file: "C:\\tools\\codex.exe", args: ["--version"] });
});

test("a relative command path is found from the directory the CLI runs in", () => {
  const launch = cliLaunch(".\\bin\\claude", ["--version"], onWindows(files("D:\\project\\bin\\claude.cmd"), windowsEnv, "D:\\project"));
  assert.equal(cmdLine(launch), '""D:\\project\\bin\\claude.cmd" --version"');
});

test("environment names are matched without regard to case, with defaults when missing", () => {
  const launch = cliLaunch("codex", ["app-server", "--stdio"], onWindows(files("C:\\npm\\prefix\\codex.cmd"), { PATH: "C:\\npm\\prefix" }));
  assert.deepEqual(launch, { file: "cmd.exe", args: ["/d", "/v:off", "/s", "/c", '""C:\\npm\\prefix\\codex.cmd" app-server --stdio"'], windowsVerbatimArguments: true });
});

test("spaces, parentheses, ampersands and ! stay inside the quoted path", () => {
  const path = "C:\\Program Files (x86)\\R&D tools!\\claude.cmd";
  assert.equal(cmdLine(cliLaunch(path, ["auth", "status", "--json"], onWindows(files(path)))), `""${path}" auth status --json"`);
});

test("a path cmd.exe would expand or split is refused rather than run", () => {
  for (const path of ["C:\\%TEMP%\\claude.cmd", 'C:\\odd"name\\claude.cmd']) {
    assert.throws(() => cliLaunch(path, ["--version"], onWindows(files(path))), /safely/);
  }
  assert.throws(() => cliLaunch("claude", ["a&b"], onWindows(npmShim)), /safely/);
});

test("a CLI that cannot be found keeps its name, so starting it fails as before", () => {
  assert.deepEqual(cliLaunch("claude", ["--version"], onWindows(() => false)), { file: "claude", args: ["--version"] });
});

test("the default home is the profile on Windows and HOME elsewhere", () => {
  const env = { HOME: "/c/Users/me", USERPROFILE: "C:\\Users\\me" };
  assert.equal(cliHome(env, "win32"), "C:\\Users\\me");
  assert.equal(cliHome({ HOME: "/c/Users/me", userprofile: "C:\\Users\\me" }, "win32"), "C:\\Users\\me");
  assert.equal(cliHome(env, "linux"), "/c/Users/me");
});

const node = (script: string) => ({ command: process.execPath, args: ["-e", script] });
const runOptions = { cwd: tmpdir(), env: process.env, timeoutMs: 5_000, maxBytes: 1_000 };

test("a CLI run returns its output, and fails on a non-zero exit", async () => {
  const ok = node("process.stdout.write('ready')");
  assert.equal(await runCli(ok.command, ok.args, runOptions), "ready");
  const failing = node("process.exit(3)");
  await assert.rejects(runCli(failing.command, failing.args, runOptions), /exited with 3/);
});

test("a CLI that hangs or floods its output is stopped and reported", async () => {
  const hang = node("setTimeout(() => {}, 60000)");
  const started = Date.now();
  await assert.rejects(runCli(hang.command, hang.args, { ...runOptions, timeoutMs: 300 }), /timed out/);
  assert.ok(Date.now() - started < 5_000);
  const flood = node("process.stdout.write('x'.repeat(5000)); setTimeout(() => {}, 60000)");
  await assert.rejects(runCli(flood.command, flood.args, runOptions), /too large/);
});

test("outside Windows a CLI is stopped at once, without waiting out the grace period", async () => {
  const child = spawnCli(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { cwd: tmpdir(), env: process.env });
  const started = Date.now();
  await stopProcessTree(child, { graceMs: 5_000, platform: "linux" });
  await new Promise((resolve) => child.once("exit", resolve));
  assert.ok(Date.now() - started < 2_000);
});
