import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCli, UnsafeShimError } from "./cli-launch";
import { isExhausted, type QuotaWindow } from "./quota";
import type { SubscriptionCheck } from "./subscription";

const CACHE_MS = 60_000;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Anything but an absent or zero turn count may mean agy started a model turn. */
const ranModelTurn = (usage: unknown): boolean => {
  const turns = record(usage).num_turns;
  return turns !== undefined && turns !== 0;
};

/** No evidence about quota: preserve Antigravity's notice/retry behavior, without a usage hold. */
export const agyFallback = (): SubscriptionCheck => ({ auth: "subscription", status: "ready" });

// Bucket IDs, not translated group names. Argon without a dedicated bucket is unverified:
// the plans documentation does not establish which shared buckets apply on every plan.
function bucketApplies(model: string, id: string): boolean {
  if (model.startsWith("gemini-4-argon-")) return id.startsWith("gemini-argon-");
  if (model.startsWith("gemini-")) return id.startsWith("gemini-") && !id.startsWith("gemini-argon-");
  if (model.startsWith("claude-") || model.startsWith("gpt-oss-")) return id.startsWith("3p-");
  return false;
}

/**
 * Applicable windows; empty when none of the response's valid buckets applies to `model`. Null
 * only when the response is not a successful read-only usage answer. Buckets the model does not
 * use, or whose fraction is unreadable, are skipped rather than failing the whole response.
 */
export function agyWindows(usage: unknown, model: string | undefined): QuotaWindow[] | null {
  const root = record(usage), command = record(root.command), groups = record(command.data).groups;
  if (root.status !== "SUCCESS" || ranModelTurn(root) || command.name !== "usage" || !Array.isArray(groups)) return null;
  if (!model) return [];
  const windows: QuotaWindow[] = [];
  for (const group of groups) {
    const buckets = record(group).buckets;
    if (!Array.isArray(buckets)) continue;
    for (const value of buckets) {
      const bucket = record(value), fraction = bucket.remaining_fraction;
      if (typeof bucket.id !== "string" || !bucketApplies(model, bucket.id) || typeof fraction !== "number" || !Number.isFinite(fraction)) continue;
      const remaining = Math.min(1, Math.max(0, fraction));
      const reset = typeof bucket.reset_time === "string" ? Date.parse(bucket.reset_time) : NaN;
      windows.push({
        id: `agy:${bucket.id}`,
        // Tiny positive fractions must not round up to an exhausted window.
        usedPct: remaining === 0 ? 100 : Math.min(100 - Number.EPSILON * 100, (1 - remaining) * 100),
        resetAt: Number.isFinite(reset) ? new Date(reset).toISOString() : null,
      });
    }
  }
  return windows;
}

/** The check the windows support; no window gives no evidence. */
const checkFromWindows = (windows: QuotaWindow[] | null): SubscriptionCheck => windows?.length
  ? { auth: "subscription", status: windows.some(isExhausted) ? "limited" : "ready", windows } : agyFallback();

export const agyUsage = (usage: unknown, model: string | undefined): SubscriptionCheck => checkFromWindows(agyWindows(usage, model));

/**
 * Conservative support floor; print-mode usage was introduced in 1.1.11. The first version in
 * the output counts, and a prerelease counts only when its release is past the floor.
 */
const SUPPORT_FLOOR = [1, 1, 12];

function supportedVersion(output: string): boolean {
  const match = /(\d+)\.(\d+)\.(\d+)(-[\w.]+)?/.exec(output);
  if (!match) return false;
  const version = match.slice(1, 4).map(Number);
  const differing = version.findIndex((part, index) => part !== SUPPORT_FLOOR[index]);
  return differing === -1 ? !match[4] : version[differing]! > SUPPORT_FLOOR[differing]!;
}

/** Why quota gave no evidence; each is logged as is, never with CLI output. */
type Unavailable =
  | "unsupported_launcher" | "missing_model" | "probe_disabled" | "unsupported_version"
  | "model_turn_detected_probe_disabled" | "unsafe_windows_shim" | "probe_failed" | "invalid_usage" | "no_applicable_bucket";

type Probe = { usage: unknown; reason?: never } | { reason: Unavailable; usage?: never };

/** How Paseo starts agy for the agent: its configured command, working directory and environment. */
export interface AgyLaunch {
  command: string[] | undefined;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Names the executable and the account data it reads: agy keeps its data under HOME (USERPROFILE
 * on Windows) or XDG directories, and a bare command name is found through PATH. A digest is only
 * a cache selector, never account identity.
 */
function launchKey(binary: string, env: NodeJS.ProcessEnv): string {
  const bare = !/[\\/]/.test(binary);
  const selectors = Object.entries(env).filter(([key]) => {
    const name = key.toUpperCase();
    return name === "HOME" || name === "USERPROFILE" || name.startsWith("XDG_") || (bare && name === "PATH");
  }).map(([key, value]) => [key.toUpperCase(), value]).sort(([a], [b]) => a!.localeCompare(b!));
  return createHash("sha256").update(JSON.stringify([binary, selectors])).digest("hex");
}

/**
 * Reads the quota that applies to an agent's model. Every failure, from an unsupported launcher to
 * an unusable answer, is logged with a fixed reason and gives the fallback; nothing is thrown.
 * Read-only probes share raw results across models.
 */
export function createAgyUsageReader(deps: {
  run?: typeof runCli;
  now?: () => number;
  log?: (message: string) => void;
} = {}) {
  const run = deps.run ?? runCli, now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string) => console.warn(`[usage-auto-resume] ${message}`));
  const cache = new Map<string, { expires: number; result: Promise<Probe> }>();
  const disabled = new Set<string>();

  async function probe(binary: string, env: NodeJS.ProcessEnv, key: string): Promise<Probe> {
    let cwd: string | undefined;
    try {
      cwd = await mkdtemp(join(tmpdir(), "paseo-agy-usage-"));
      const options = { cwd, env, maxBytes: 200_000 };
      if (!supportedVersion(await run(binary, ["--version"], { ...options, timeoutMs: 5_000 }))) return { reason: "unsupported_version" };
      const usage: unknown = JSON.parse(await run(binary, ["-p", "/usage", "--output-format", "json"], { ...options, timeoutMs: 20_000 }));
      if (ranModelTurn(usage)) {
        disabled.add(key);
        return { reason: "model_turn_detected_probe_disabled" };
      }
      return { usage };
    } catch (error) {
      // Output and errors may contain account data; only a fixed reason leaves this module.
      return { reason: error instanceof UnsafeShimError ? "unsafe_windows_shim" : "probe_failed" };
    } finally {
      if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
  }

  return async (launch: AgyLaunch, model: string | undefined, agentId: string): Promise<SubscriptionCheck> => {
    const unavailable = (reason: Unavailable) => {
      log(`antigravity usage unavailable for ${agentId}: ${reason}`);
      return agyFallback();
    };
    const command = launch.command ?? ["agy"];
    // Arguments a launcher adds before agy's own are ambiguous for a status command.
    if (command.length !== 1 || !command[0]) return unavailable("unsupported_launcher");
    if (!model) return unavailable("missing_model");
    // The probe runs in a temporary directory, so a relative launch path is resolved where Paseo runs agy.
    const binary = /[\\/]/.test(command[0]) ? resolve(launch.cwd, command[0]) : command[0];
    const key = launchKey(binary, launch.env);
    if (disabled.has(key)) return unavailable("probe_disabled");
    for (const [id, entry] of cache) if (entry.expires <= now()) cache.delete(id);
    let entry = cache.get(key);
    if (!entry) {
      entry = { expires: Infinity, result: probe(binary, launch.env, key) };
      cache.set(key, entry);
      const pending = entry;
      void entry.result.then(() => { pending.expires = now() + CACHE_MS; });
    }
    const result = await entry.result;
    if (result.reason) return unavailable(result.reason);
    const windows = agyWindows(result.usage, model);
    if (!windows) return unavailable("invalid_usage");
    return windows.length ? checkFromWindows(windows) : unavailable("no_applicable_bucket");
  };
}
