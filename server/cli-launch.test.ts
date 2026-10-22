import assert from "node:assert/strict";
import { test } from "node:test";
import { cliHome, cliLaunch } from "./cli-launch";

const files = (...paths: string[]) => (path: string) => paths.map((entry) => entry.toLowerCase()).includes(path.toLowerCase());
const windows = { Path: "C:\\Windows\\system32;C:\\npm\\prefix;C:\\Users\\me\\.local\\bin", PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: "C:\\Windows\\system32\\cmd.exe" };
const npmShim = files("C:\\npm\\prefix\\claude", "C:\\npm\\prefix\\claude.cmd");

test("other platforms start the command as given", () => {
  assert.deepEqual(cliLaunch("claude", ["auth", "status", "--json"], { PATH: "/usr/bin" }, "linux", () => assert.fail("no lookup")),
    { file: "claude", args: ["auth", "status", "--json"] });
  assert.deepEqual(cliLaunch("/opt/codex", ["app-server", "--stdio"], {}, "darwin"), { file: "/opt/codex", args: ["app-server", "--stdio"] });
});

test("a Windows npm shim runs through cmd.exe with its path quoted", () => {
  assert.deepEqual(cliLaunch("claude", ["auth", "status", "--json"], windows, "win32", npmShim), {
    file: "C:\\Windows\\system32\\cmd.exe",
    args: ["/d", "/s", "/c", '""C:\\npm\\prefix\\claude.cmd" auth status --json"'],
    windowsVerbatimArguments: true,
  });
});

test("the extensionless POSIX script beside an npm shim is never chosen", () => {
  const launch = cliLaunch("C:\\npm\\prefix\\claude", ["--version"], windows, "win32", npmShim);
  assert.equal(launch.args.at(-1), '""C:\\npm\\prefix\\claude.cmd" --version"');
});

test("a native executable starts directly, in PATH and then PATHEXT order", () => {
  const both = files("C:\\npm\\prefix\\claude.cmd", "C:\\Users\\me\\.local\\bin\\claude.exe", "C:\\npm\\prefix\\claude.exe");
  assert.deepEqual(cliLaunch("claude", ["--version"], windows, "win32", both), { file: "C:\\npm\\prefix\\claude.exe", args: ["--version"] });
  const native = files("C:\\Users\\me\\.local\\bin\\claude.exe");
  assert.deepEqual(cliLaunch("claude", ["--version"], windows, "win32", native), { file: "C:\\Users\\me\\.local\\bin\\claude.exe", args: ["--version"] });
  assert.deepEqual(cliLaunch("C:\\tools\\codex.exe", ["--version"], windows, "win32", files("C:\\tools\\codex.exe")),
    { file: "C:\\tools\\codex.exe", args: ["--version"] });
});

test("environment names are matched without regard to case, with defaults when missing", () => {
  const launch = cliLaunch("codex", ["app-server", "--stdio"], { PATH: "C:\\npm\\prefix" }, "win32", files("C:\\npm\\prefix\\codex.cmd"));
  assert.deepEqual(launch, { file: "cmd.exe", args: ["/d", "/s", "/c", '""C:\\npm\\prefix\\codex.cmd" app-server --stdio"'], windowsVerbatimArguments: true });
});

test("spaces, parentheses and ampersands stay inside the quoted path", () => {
  const path = "C:\\Program Files (x86)\\R&D tools\\claude.cmd";
  const launch = cliLaunch(path, ["auth", "status", "--json"], windows, "win32", files(path));
  assert.equal(launch.args.at(-1), `""${path}" auth status --json"`);
});

test("a path cmd.exe would expand or split is refused rather than run", () => {
  for (const path of ["C:\\%TEMP%\\claude.cmd", 'C:\\odd"name\\claude.cmd']) {
    assert.throws(() => cliLaunch(path, ["--version"], windows, "win32", files(path)), /safely/);
  }
  assert.throws(() => cliLaunch("claude", ["a&b"], windows, "win32", npmShim), /safely/);
});

test("a CLI that cannot be found keeps its name, so starting it fails as before", () => {
  assert.deepEqual(cliLaunch("claude", ["--version"], windows, "win32", () => false), { file: "claude", args: ["--version"] });
});

test("the default home is the profile on Windows and HOME elsewhere", () => {
  const env = { HOME: "/c/Users/me", USERPROFILE: "C:\\Users\\me" };
  assert.equal(cliHome(env, "win32"), "C:\\Users\\me");
  assert.equal(cliHome({ HOME: "/c/Users/me", userprofile: "C:\\Users\\me" }, "win32"), "C:\\Users\\me");
  assert.equal(cliHome(env, "linux"), "/c/Users/me");
});
