import assert from "node:assert/strict";
import { test } from "node:test";
import type { DiscoveredProvider, ScheduledJob } from "../shared/rpc";
import {
  bulkAction,
  dayChoices,
  dayLabel,
  dayOffset,
  groupByDay,
  placeLabel,
  providerHint,
  providerLabel,
  refusalLabel,
  relativeLabel,
  rescheduleProblem,
  sortProviders,
  summaryLabels,
  timeOnDay,
} from "./format";

const job = (overrides: Partial<ScheduledJob>): ScheduledJob => ({
  agentId: "a",
  provider: "codex",
  title: "Task",
  projectName: null,
  workspaceName: null,
  resetAt: null,
  dueAt: new Date(2026, 9, 6, 18, 53).toISOString(),
  enabled: true,
  sending: false,
  ...overrides,
});
const now = new Date(2026, 9, 6, 17, 1).getTime();

test("countdowns round up to the minute", () => {
  assert.equal(relativeLabel(new Date(2026, 9, 6, 18, 53).toISOString(), now), "in 1h 52m");
  assert.equal(relativeLabel(new Date(2026, 9, 6, 17, 30, 30).toISOString(), now), "in 30m");
  assert.equal(relativeLabel(new Date(2026, 9, 6, 19, 1).toISOString(), now), "in 2h");
  assert.equal(relativeLabel(new Date(2026, 9, 6, 16, 0).toISOString(), now), "now");
});

test("days are named relative to today", () => {
  assert.equal(dayLabel(new Date(2026, 9, 6, 23, 59).toISOString(), now), "Today");
  assert.equal(dayLabel(new Date(2026, 9, 7, 0, 1).toISOString(), now), "Tomorrow");
  assert.equal(dayLabel(new Date(2026, 9, 9, 4, 13).toISOString(), now), "Fri, Oct 9");
});

test("jobs are grouped by consecutive day", () => {
  const groups = groupByDay(
    [job({ agentId: "a" }), job({ agentId: "b" }), job({ agentId: "c", dueAt: new Date(2026, 9, 7, 9).toISOString() })],
    now,
  );
  assert.deepEqual(groups.map((group) => [group.label, group.jobs.length]), [["Today", 2], ["Tomorrow", 1]]);
});

test("summary counts agents that will continue and names the next time", () => {
  const later = job({ dueAt: new Date(2026, 9, 6, 20, 0).toISOString() });
  assert.deepEqual(summaryLabels([job({}), later]), { title: "2 agents will continue", detail: "Next at 18:53" });
  assert.deepEqual(summaryLabels([job({ enabled: false }), later]), {
    title: "1 agent will continue",
    detail: "Next at 20:00 · 1 skipped",
  });
  assert.deepEqual(summaryLabels([job({ enabled: false })]), { title: "All turned off", detail: null });
});

test("verification checks are displayed separately from promised continues", () => {
  assert.deepEqual(summaryLabels([job({ waiting: "usage" })]), {
    title: "1 agent waiting for verification", detail: "Next check at 18:53",
  });
  assert.deepEqual(summaryLabels([job({ waiting: "auth" }), job({ dueAt: new Date(2026, 9, 6, 20, 0).toISOString() })]), {
    title: "1 agent will continue", detail: "Next at 20:00 · 1 waiting",
  });
});

test("labels for provider and place", () => {
  assert.equal(providerLabel("claude-main"), "Claude Main");
  assert.equal(providerLabel("antigravity"), "Antigravity");
  assert.equal(providerLabel("antigravity-main"), "Antigravity Main");
  assert.equal(placeLabel(job({ projectName: "DoneFolio", workspaceName: "DoneFolio" })), "DoneFolio");
  assert.equal(placeLabel(job({ projectName: "DoneFolio", workspaceName: "issue-233" })), "DoneFolio · issue-233");
  assert.equal(placeLabel(job({})), null);
});

const provider = (overrides: Partial<DiscoveredProvider>): DiscoveredProvider => ({
  id: "codex",
  label: "Codex",
  cli: "codex",
  paseoEnabled: true,
  account: null,
  ...overrides,
});

test("a provider's switch names its ID, account, and pending reservations", () => {
  assert.equal(providerHint(provider({ account: "me@example.com" }), 2), "codex · me@example.com · 2 pending reservations");
  assert.equal(providerHint(provider({ id: "codex-sub" }), 1), "codex-sub · 1 pending reservation");
  assert.equal(providerHint(provider({ paseoEnabled: false }), 0), "codex · off in Paseo");
});

test("the CLI's own provider comes first, then the rest by name", () => {
  const sorted = sortProviders([
    provider({ id: "codex-sub", label: "Codex Sub" }),
    provider({ id: "codex-reserve", label: "Codex Reserve" }),
    provider({}),
  ]);
  assert.deepEqual(sorted.map((entry) => entry.id), ["codex", "codex-reserve", "codex-sub"]);
});

test("a typed time lands on the chosen day in local time", () => {
  assert.equal(timeOnDay("07:30", 1, now), new Date(2026, 9, 7, 7, 30).toISOString());
  assert.equal(timeOnDay("7:05", 0, now), new Date(2026, 9, 6, 7, 5).toISOString());
  assert.equal(timeOnDay("2215", 0, now), new Date(2026, 9, 6, 22, 15).toISOString());
  assert.equal(timeOnDay(" 23:59 ", 3, now), new Date(2026, 9, 9, 23, 59).toISOString());
  for (const bad of ["", "24:00", "12:60", "noon", "1:2", "12:345"]) assert.equal(timeOnDay(bad, 0, now), null, bad);
});

test("day choices are today and tomorrow, plus the job's own day when it is later", () => {
  assert.deepEqual(dayChoices(new Date(2026, 9, 6, 18, 53).toISOString(), now), [
    { offset: 0, label: "Today" },
    { offset: 1, label: "Tomorrow" },
  ]);
  assert.deepEqual(dayChoices(new Date(2026, 9, 9, 4, 13).toISOString(), now), [
    { offset: 0, label: "Today" },
    { offset: 1, label: "Tomorrow" },
    { offset: 3, label: "Fri, Oct 9" },
  ]);
  assert.equal(dayOffset(new Date(2026, 9, 9, 4, 13).toISOString(), now), 3);
});

test("a new time before the reset or over a week out is explained before it is sent", () => {
  const limited = job({ resetAt: new Date(2026, 9, 6, 18, 51).toISOString() });
  assert.equal(
    rescheduleProblem(limited, new Date(2026, 9, 6, 18, 0).toISOString(), now),
    "Too early — the limit resets at 18:51. Earliest is 18:53.",
  );
  assert.equal(rescheduleProblem(limited, new Date(2026, 9, 6, 18, 53).toISOString(), now), null);
  assert.equal(
    rescheduleProblem(job({}), new Date(2026, 9, 6, 17, 1, 30).toISOString(), now),
    "Too early — earliest is 17:02.",
  );
  assert.equal(rescheduleProblem(job({}), new Date(2026, 9, 13, 18, 2).toISOString(), now), "Pick a time within 7 days.");
  assert.equal(rescheduleProblem(job({}), new Date(2026, 9, 13, 18, 1).toISOString(), now), null);
});

test("the server's refusals read the same way", () => {
  const limited = job({ resetAt: new Date(2026, 9, 6, 18, 51).toISOString() });
  const earliest = new Date(2026, 9, 6, 18, 53).toISOString();
  assert.equal(refusalLabel(limited, { changed: false, reason: "too-early", earliest }), "Too early — the limit resets at 18:51. Earliest is 18:53.");
  assert.equal(refusalLabel(limited, { changed: false, reason: "too-late" }), "Pick a time within 7 days.");
  assert.equal(refusalLabel(limited, { changed: false, reason: "sending" }), "This agent is continuing now.");
  assert.equal(refusalLabel(limited, { changed: false, reason: "changed" }), "This schedule already ran or changed.");
});

test("one bulk button turns everything off while anything is on", () => {
  assert.deepEqual(bulkAction([job({}), job({ enabled: false })]), { enabled: false, label: "Turn all off", shortLabel: "All off" });
  assert.deepEqual(bulkAction([job({ enabled: false }), job({ sending: true })]), { enabled: true, label: "Turn all on", shortLabel: "All on" });
});
