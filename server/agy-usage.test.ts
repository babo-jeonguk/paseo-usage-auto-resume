import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { agyFallback, agyUsage, agyWindows, createAgyUsageReader } from "./agy-usage";
import { UnsafeShimError } from "./cli-launch";
import { captureLaunch, createSubscriptionReader } from "./subscription";
import type { PaseoAgent, PaseoApi } from "./paseo-types";

// Synthetic depleted third-party quota; the group/bucket shape follows the 1.4.8 handoff.
const fixture = JSON.parse(readFileSync(new URL("./fixtures/agy-usage-synthetic.json", import.meta.url), "utf8"));
const copy = () => structuredClone(fixture);
const flash = "gemini-3.8-flash-high";
const at = new Date("2026-10-28T00:00:00Z");
const agent = { id: "agy-agent", provider: "antigravity", cwd: "/project", model: flash } as PaseoAgent;
const api = (command?: string[]) => ({ config: { get: async () => ({ config: { providers: { antigravity: { command } } } }) } }) as unknown as Pick<PaseoApi, "config">;
const launchOf = (env: NodeJS.ProcessEnv, command = ["agy"]) => ({ command, cwd: "/project", env });
const launch = captureLaunch({ env: { GEMINI_API_KEY: "", AGY_ADC_AUTH: "", GOOGLE_GEMINI_BASE_URL: "" } });

test("the sanitized live 1.4.9 response maps all observed model families as ready", () => {
  const live = JSON.parse(readFileSync(new URL("./fixtures/agy-usage-1.4.9.json", import.meta.url), "utf8"));
  for (const model of [flash, "gemini-4-argon-high", "claude-opus-5-5-high", "gpt-oss-120b-medium"]) {
    const check = agyUsage(live, model);
    assert.equal(check.status, "ready");
    assert.ok(check.windows?.length);
  }
});

test("usage maps only the selected model's buckets, without account identity", () => {
  for (const [model, ids, status] of [
    [flash, ["gemini-weekly", "gemini-5h"], "ready"],
    ["gemini-4-argon-high", ["gemini-argon-wtu-weekly"], "ready"],
    ["claude-opus-5-5-high", ["3p-weekly", "3p-5h"], "limited"],
    ["gpt-oss-120b-medium", ["3p-weekly", "3p-5h"], "limited"],
  ] as const) {
    const check = agyUsage(fixture, model);
    assert.equal(check.status, status);
    assert.deepEqual(check.windows?.map((w) => w.id), ids.map((id) => `agy:${id}`));
    assert.equal(check.identity, undefined);
  }
  assert.equal(agyUsage(fixture, "claude-opus-5-5-high").windows?.[0]?.resetAt, "2026-11-01T15:15:44.000Z");
});

test("zero alone is exhausted; stale or missing reset never makes zero ready", () => {
  for (const remaining of [0, Number.MIN_VALUE, 0.5, 1]) {
    const usage = copy();
    Object.assign(usage.command.data.groups[0].buckets[1], { remaining_fraction: remaining, reset_time: "invalid" });
    const check = agyUsage(usage, flash);
    assert.equal(check.status, remaining === 0 ? "limited" : "ready");
    assert.equal(check.windows?.[1]?.resetAt, null);
  }
});

test("unsupported models and responses that are not a usage answer preserve the fallback", () => {
  for (const model of [undefined, "unknown", "auto"]) assert.deepEqual(agyUsage(fixture, model), agyFallback());
  const noArgon = copy(); noArgon.command.data.groups.pop();
  assert.deepEqual(agyWindows(noArgon, "gemini-4-argon-high"), []);
  const mutations = [
    (u: any) => { u.num_turns = 1; },
    (u: any) => { u.status = "ERROR"; },
    (u: any) => { u.command.name = "credits"; },
    (u: any) => { delete u.command.data.groups; },
  ];
  for (const change of mutations) { const usage = copy(); change(usage); assert.equal(agyWindows(usage, flash), null); }
  assert.equal(agyWindows("not JSON", flash), null);
});

test("unrelated or unreadable buckets are skipped and fractions are clamped", () => {
  const usage = copy();
  delete usage.num_turns;
  usage.command.data.groups.push({ name: "Future" }, null, { buckets: [{ id: "credits-pool" }, { remaining_fraction: 0 }] });
  usage.command.data.groups[2].buckets[0].remaining_fraction = "broken";
  assert.deepEqual(agyWindows(usage, flash)?.map((w) => w.id), ["agy:gemini-weekly", "agy:gemini-5h"]);
  assert.deepEqual(agyUsage(usage, "gemini-4-argon-high"), agyFallback(), "an unreadable applicable bucket alone gives no evidence");
  for (const [value, status, windows] of [[NaN, "ready", 1], [null, "ready", 1], [-0.1, "limited", 2], [1.1, "ready", 2]] as const) {
    const changed = copy();
    changed.command.data.groups[0].buckets[0].remaining_fraction = value;
    const check = agyUsage(changed, flash);
    assert.equal(check.status, status, String(value));
    assert.equal(check.windows?.length, windows, String(value));
  }
});

test("version gate precedes usage and both commands run in a disposable cwd with bounded output", async () => {
  for (const [version, supported] of [["1.1.11", false], ["garbage", false], ["1.1.12-rc.1", false], ["1.1.12", true], ["1.4.9-beta", true], ["agy version 1.4.9 (abc123)\n", true], ["1.4.9\n", true]] as const) {
    const calls: string[][] = []; let cwd = "";
    const read = createAgyUsageReader({ log: () => {}, run: async (binary, args, options) => {
      assert.equal(binary, "agy");
      assert.notEqual(options.cwd, agent.cwd);
      assert.equal((await stat(options.cwd)).isDirectory(), true);
      cwd = options.cwd;
      assert.equal(options.maxBytes, 200_000);
      calls.push(args);
      if (args[0] === "--version") { assert.equal(options.timeoutMs, 15_000); return version; }
      assert.equal(options.timeoutMs, 60_000);
      return JSON.stringify(fixture);
    } });
    const check = await read(launchOf({}), flash, "a");
    assert.equal(!!check.windows, supported);
    assert.deepEqual(calls, supported ? [["--version"], ["-p", "/usage", "--output-format", "json"]] : [["--version"]]);
    await assert.rejects(stat(cwd), { code: "ENOENT" });
  }
});

test("concurrent models share raw usage, cache expires, and environment changes isolate probes", async () => {
  let now = 0, probes = 0;
  const read = createAgyUsageReader({ now: () => now, run: async (_binary, args) => {
    if (args[0] === "--version") return "1.4.9";
    probes++;
    return JSON.stringify(fixture);
  } });
  const [gemini, claude] = await Promise.all([read(launchOf({ HOME: "/a" }), flash, "a"), read(launchOf({ HOME: "/a" }), "claude-opus-5-5", "b")]);
  assert.equal(probes, 1); assert.equal(gemini.status, "ready"); assert.equal(claude.status, "limited");
  now = 59_999; await read(launchOf({ HOME: "/a" }), flash, "a"); assert.equal(probes, 1);
  now = 60_000; await read(launchOf({ HOME: "/a" }), flash, "a"); assert.equal(probes, 2);
  await read(launchOf({ HOME: "/b" }), flash, "b"); assert.equal(probes, 3);
  await read(launchOf({ HOME: "/b", PATH: "/different" }), flash, "b"); assert.equal(probes, 4);
  await read(launchOf({ HOME: "/b", PATH: "/different", TERM: "dumb" }), flash, "b");
  assert.equal(probes, 4, "variables that select neither the executable nor its data share the probe");
  await read(launchOf({ HOME: "/b", PATH: "/one" }, ["/opt/agy"]), flash, "b");
  await read(launchOf({ HOME: "/b", PATH: "/two" }, ["/opt/agy"]), flash, "b");
  assert.equal(probes, 5, "an explicit path is not looked up through PATH");
});

test("failures are cached without logging their contents; accidental model turns disable the launch", async () => {
  for (const failure of ["throw", "json", "turn", "turn-text"] as const) {
    let now = 0, probes = 0; const logs: string[] = [];
    const read = createAgyUsageReader({ now: () => now, log: (line) => logs.push(line), run: async (_binary, args) => {
      if (args[0] === "--version") return "1.4.9";
      probes++;
      if (failure === "throw") throw new Error("private-stderr");
      return failure === "json" ? "private-output" : JSON.stringify({ ...fixture, num_turns: failure === "turn" ? 1 : "1" });
    } });
    const turned = failure.startsWith("turn");
    assert.deepEqual(await read(launchOf({ HOME: "/a" }), flash, "a"), agyFallback());
    await read(launchOf({ HOME: "/a" }), flash, "a"); assert.equal(probes, 1);
    now = 61_000; await read(launchOf({ HOME: "/a", TERM: "dumb" }), flash, "a"); assert.equal(probes, turned ? 1 : 2);
    assert.doesNotMatch(logs.join("\n"), /private/);
    if (turned) assert.match(logs[0]!, /model_turn_detected/);
  }
});

test("any turn count other than absent or zero rejects the answer", () => {
  for (const turns of [1, "1", "0", null, -1]) assert.equal(agyWindows({ ...fixture, num_turns: turns }, flash), null, String(turns));
  const { num_turns: _omitted, ...withoutTurns } = fixture;
  assert.equal(agyWindows(withoutTurns, flash)?.length, 2);
});

test("an unusable answer and a model without buckets log different reasons", async () => {
  const logs: string[] = [];
  let usage: unknown = fixture;
  const read = createAgyUsageReader({ log: (line) => logs.push(line), run: async (_binary, args) => args[0] === "--version" ? "1.4.9" : JSON.stringify(usage) });
  assert.deepEqual(await read(launchOf({ HOME: "/a" }), "unknown-model", "a"), agyFallback());
  usage = { ...fixture, status: "ERROR" };
  assert.deepEqual(await read(launchOf({ HOME: "/b" }), flash, "b"), agyFallback());
  assert.deepEqual(logs.map((line) => line.split(": ")[1]), ["no_applicable_bucket", "invalid_usage"]);
});

test("a Windows shim that cannot pass /usage safely is named in the log", async () => {
  const logs: string[] = [];
  const read = createAgyUsageReader({ log: (line) => logs.push(line), run: async (_binary, args) => {
    if (args[0] === "--version") return "1.4.9";
    throw new UnsafeShimError();
  } });
  assert.deepEqual(await read(launchOf({ HOME: "/a" }), flash, "a"), agyFallback());
  assert.deepEqual(logs.map((line) => line.split(": ")[1]), ["unsafe_windows_shim"]);
});

test("subscription integration skips API, identity and ambiguous launchers; usage uses agy", async () => {
  let calls = 0;
  const read = createSubscriptionReader({ run: async (binary, args) => {
    calls++; assert.equal(binary, "agy");
    return args[0] === "--version" ? "1.4.9" : JSON.stringify(fixture);
  } });
  for (const key of ["GEMINI_API_KEY", "AGY_ADC_AUTH", "GOOGLE_GEMINI_BASE_URL"]) {
    assert.equal((await read(api(), agent, "antigravity", at, { ...launch, authEnv: { ...launch.authEnv, [key]: true } })).auth, "api");
  }
  assert.deepEqual(await read(api(), agent, "antigravity", at, launch, "identity"), agyFallback());
  assert.deepEqual(await read(api(["wrapper", "arg"]), agent, "antigravity", at, launch), agyFallback());
  assert.equal(calls, 0);
  assert.equal((await read(api(), agent, "antigravity", at, launch)).windows?.length, 2);
  assert.equal(calls, 2);
});

test("an Antigravity route that cannot be classified waits for verification without running agy", async () => {
  const read = createSubscriptionReader({ run: async () => { throw new Error("must not run agy"); } });
  const unreadable = { config: { get: async () => { throw new Error("config unavailable"); } } } as unknown as Pick<PaseoApi, "config">;
  const cyclic = { config: { get: async () => ({ config: { providers: { antigravity: { extends: "loop" }, loop: { extends: "antigravity" } } } }) } } as unknown as Pick<PaseoApi, "config">;
  for (const config of [unreadable, cyclic]) assert.deepEqual(await read(config, agent, "antigravity", at, launch), { auth: "unknown", status: "unknown" });
});

test("a relative launcher path is probed where Paseo runs agy", async () => {
  const binaries: string[] = [];
  const read = createAgyUsageReader({ log: () => {}, run: async (binary, args) => {
    binaries.push(binary);
    return args[0] === "--version" ? "1.4.9" : JSON.stringify(fixture);
  } });
  await read({ command: ["./bin/agy"], cwd: "/project", env: {} }, flash, "a");
  // Resolved like a path Paseo spawns from that cwd, with the drive on Windows.
  assert.deepEqual(binaries, [resolve("/project", "bin/agy"), resolve("/project", "bin/agy")]);
});

test("the real process runner reads a fake agy executable without a model or account", { skip: process.platform === "win32" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "agy-process-test-"));
  try {
    const binary = join(home, "agy");
    await writeFile(binary, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.join(' ') === '--version') console.log('1.4.9');
else if (args.join(' ') === '-p /usage --output-format json') console.log(${JSON.stringify(JSON.stringify(fixture))});
else process.exit(10);
`, { mode: 0o755 });
    const read = createSubscriptionReader();
    const context = { ...launch, env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? "" } };
    const check = await read(api([binary]), { ...agent, model: "claude-sonnet-5-5-high" }, "antigravity", at, context);
    assert.equal(check.status, "limited");
    assert.equal(check.windows?.[0]?.id, "agy:3p-weekly");
  } finally { await rm(home, { recursive: true, force: true }); }
});
