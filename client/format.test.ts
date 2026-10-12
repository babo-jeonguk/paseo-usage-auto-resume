import assert from "node:assert/strict";
import { test } from "node:test";
import type { ScheduledJob } from "../shared/rpc";
import { dayLabel, groupByDay, placeLabel, providerLabel, relativeLabel, summaryLabels } from "./format";

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

test("labels for provider and place", () => {
  assert.equal(providerLabel("claude-main"), "Claude Main");
  assert.equal(placeLabel(job({ projectName: "DoneFolio", workspaceName: "DoneFolio" })), "DoneFolio");
  assert.equal(placeLabel(job({ projectName: "DoneFolio", workspaceName: "issue-233" })), "DoneFolio · issue-233");
  assert.equal(placeLabel(job({})), null);
});
