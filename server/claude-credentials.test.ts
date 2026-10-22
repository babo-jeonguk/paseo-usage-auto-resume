import assert from "node:assert/strict";
import { test } from "node:test";
import { createClaudeCredentialReader } from "./claude-credentials";

const raw = JSON.stringify({ claudeAiOauth: { accessToken: "fixture-token", expiresAt: 1_900_000_000_000, refreshToken: "not-returned" } });
const expected = { accessToken: "fixture-token", expiresAt: 1_900_000_000_000 };
const base = { HOME: "/tmp/fixture-home", USER: "fixture-user" };

for (const [name, selection, service] of [
  ["default", {}, "Claude Code-credentials"],
  ["personal", { CLAUDE_CONFIG_DIR: "/tmp/claude-personal" }, "Claude Code-credentials-deace5d6"],
  ["team", { CLAUDE_CONFIG_DIR: "/tmp/claude-team" }, "Claude Code-credentials-a6dbaaea"],
  ["NFC", { CLAUDE_CONFIG_DIR: "/tmp/claude\u0301" }, "Claude Code-credentials-05b754cb"],
  ["storage override", { CLAUDE_CONFIG_DIR: "/tmp/claude-team", CLAUDE_SECURESTORAGE_CONFIG_DIR: "/tmp/shared" }, "Claude Code-credentials-a92af850"],
  ["empty storage override", { CLAUDE_CONFIG_DIR: "/tmp/claude-team", CLAUDE_SECURESTORAGE_CONFIG_DIR: "" }, "Claude Code-credentials"],
] as const) test(`macOS credentials: ${name} selects the exact Keychain service`, async () => {
  let queries = 0;
  const env = { ...base, ...selection };
  const read = createClaudeCredentialReader({ platform: "darwin", runSecurity: async (args, receivedEnv) => {
    queries++;
    assert.deepEqual(args, ["find-generic-password", "-a", "fixture-user", "-w", "-s", service]);
    assert.equal(receivedEnv, env);
    return raw;
  }, readFile: async () => { throw new Error("a valid Keychain record must win over a fallback file"); } });
  assert.deepEqual(await read(env), expected);
  assert.equal(queries, 1);
});

test("macOS credentials: unsupported username characters use the CLI's fallback account", async () => {
  const read = createClaudeCredentialReader({ platform: "darwin", runSecurity: async (args) => {
    assert.equal(args[2], "claude-code-user");
    return raw;
  } });
  assert.deepEqual(await read({ ...base, USER: "name@example.invalid" }), expected);
});

for (const first of ["absent", "denied", "timeout", "malformed", "missing-token"] as const) {
  test(`macOS credentials: ${first} account lookup tries the same service's legacy item`, async () => {
    const calls: string[][] = [];
    const read = createClaudeCredentialReader({ platform: "darwin", runSecurity: async (args) => {
      calls.push(args);
      if (calls.length === 1) {
        if (first === "denied" || first === "timeout") throw new Error(first);
        return first === "absent" ? "" : first === "malformed" ? "not-json" : '{"claudeAiOauth":{}}';
      }
      return raw;
    } });
    assert.deepEqual(await read({ ...base, CLAUDE_CONFIG_DIR: "/tmp/claude-team" }), expected);
    assert.deepEqual(calls[1], ["find-generic-password", "-w", "-s", "Claude Code-credentials-a6dbaaea"]);
    assert.equal(calls.length, 2);
  });
}

for (const [selection, path] of [
  [{}, "/tmp/fixture-home/.claude/.credentials.json"],
  [{ CLAUDE_CONFIG_DIR: "/tmp/claude-team" }, "/tmp/claude-team/.credentials.json"],
  [{ CLAUDE_CONFIG_DIR: "/tmp/claude-team", CLAUDE_SECURESTORAGE_CONFIG_DIR: "/tmp/shared" }, "/tmp/shared/.credentials.json"],
  [{ CLAUDE_CONFIG_DIR: "/tmp/claude-team", CLAUDE_SECURESTORAGE_CONFIG_DIR: "" }, "/tmp/fixture-home/.claude/.credentials.json"],
] as const) test(`macOS credentials: unavailable Keychain falls back only to ${path}`, async () => {
  let files = 0;
  const read = createClaudeCredentialReader({ platform: "darwin", runSecurity: async () => { throw new Error("locked"); },
    readFile: async (actual) => { files++; assert.equal(actual.replaceAll("\\", "/"), path); return raw; } });
  assert.deepEqual(await read({ ...base, ...selection }), expected);
  assert.equal(files, 1);
});

for (const failed of ["unavailable", "malformed", "null", "missing-token"] as const) test(`macOS credentials: ${failed} fallback returns no credential or raw error`, async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const read = createClaudeCredentialReader({ platform: "darwin", runSecurity: async () => { throw new Error("fixture-token must not be logged"); },
    readFile: async () => {
      if (failed === "unavailable") throw new Error("fixture-token must not be logged");
      return failed === "malformed" ? "not-json" : failed === "null" ? "null" : '{"claudeAiOauth":{}}';
    } });
  assert.equal(await read(base), null);
  assert.equal(errors.mock.callCount(), 0);
});

test("macOS credentials: an expired selected item is not replaced with a different file credential", async () => {
  let files = 0;
  const read = createClaudeCredentialReader({ platform: "darwin", runSecurity: async () =>
    JSON.stringify({ claudeAiOauth: { accessToken: "expired-fixture", expiresAt: 1 } }),
  readFile: async () => { files++; return raw; } });
  assert.deepEqual(await read(base), { accessToken: "expired-fixture", expiresAt: 1 });
  assert.equal(files, 0);
});

for (const platform of ["linux", "win32"] as const) test(`${platform} credentials: file store without a Keychain probe`, async () => {
  const read = createClaudeCredentialReader({ platform, runSecurity: async () => { assert.fail("must not call security"); },
    readFile: async (path) => { assert.equal(path.replaceAll("\\", "/"), "/tmp/shared/.credentials.json"); return raw; } });
  assert.deepEqual(await read({ ...base, CLAUDE_CONFIG_DIR: "/tmp/claude-team", CLAUDE_SECURESTORAGE_CONFIG_DIR: "/tmp/shared" }), expected);
});

test("win32 credentials: the profile decides the default store even when HOME points elsewhere", async () => {
  const read = createClaudeCredentialReader({ platform: "win32", runSecurity: async () => { assert.fail("must not call security"); },
    readFile: async (path) => { assert.equal(path.replaceAll("\\", "/"), "C:/Users/me/.claude/.credentials.json"); return raw; } });
  assert.deepEqual(await read({ HOME: "C:\\msys64\\home\\me", USERPROFILE: "C:\\Users\\me" }), expected);
});

test("the CLI's reported config directory decides the default store, below explicit overrides", async () => {
  const paths: string[] = [];
  const read = createClaudeCredentialReader({ platform: "linux", readFile: async (path) => { paths.push(path.replaceAll("\\", "/")); return raw; } });
  await read({ HOME: "/home/me" }, "/srv/claude");
  await read({ HOME: "/home/me", CLAUDE_CONFIG_DIR: "/tmp/claude-team" }, "/srv/claude");
  await read({ HOME: "/home/me" });
  assert.deepEqual(paths, ["/srv/claude/.credentials.json", "/tmp/claude-team/.credentials.json", "/home/me/.claude/.credentials.json"]);
});
