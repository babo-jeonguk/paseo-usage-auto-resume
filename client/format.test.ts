import assert from "node:assert/strict";
import { test } from "node:test";
import { HistoryReasonSchema, type DiscoveredProvider, type HistoryOutcome, type HistoryReason, type ResumeNowResult, type ScheduledJob } from "../shared/rpc";
import { DEFAULT_CONTINUE_PROMPT } from "../shared/prompt";
import {
  bulkAction,
  charactersLeft,
  composerLabel,
  dayChoices,
  dayLabel,
  dayOffset,
  delayChoices,
  groupByDay,
  historyLabel,
  historySummary,
  historyDateLabel,
  noteRefusal,
  notePreview,
  placeLabel,
  promptToSave,
  providerHint,
  providerLabel,
  refusalLabel,
  relativeLabel,
  rescheduleProblem,
  resumeNowToast,
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

test("composer labels distinguish off, sending, verification and later calendar days", () => {
  assert.equal(composerLabel(job({}), now), "Resume 18:53");
  assert.equal(composerLabel(job({ enabled: false }), now), "Resume off");
  assert.equal(composerLabel(job({ sending: true, enabled: false }), now), "Resuming…");
  const tomorrow = new Date(2026, 9, 7, 8, 30).toISOString();
  assert.equal(composerLabel(job({ dueAt: tomorrow, waiting: "auth" }), now), "Check 08:30");
  const weekly = new Date(2026, 9, 11, 8, 30).toISOString();
  assert.equal(composerLabel(job({ dueAt: weekly }), now), "Sun 08:30");
});

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

test("delay presets add to the reservation's time and are offered only within the allowed window", () => {
  const at = (day: number, hours: number, minutes: number) => new Date(2026, 9, day, hours, minutes).toISOString();
  assert.deepEqual(delayChoices(job({}), now), [
    { label: "+10m", spoken: "Delay 10 minutes", dueAt: at(6, 19, 3), problem: null },
    { label: "+30m", spoken: "Delay 30 minutes", dueAt: at(6, 19, 23), problem: null },
    { label: "+1h", spoken: "Delay 1 hour", dueAt: at(6, 19, 53), problem: null },
  ]);
  const nearLimit = delayChoices(job({ dueAt: at(13, 17, 30) }), now);
  assert.deepEqual(nearLimit.map((choice) => choice.problem !== null), [false, false, true]);
});

test("each Resume now result reads as one toast, colored by what it means", () => {
  const toast = (result: ResumeNowResult) => { const { tone, message } = resumeNowToast(result, now); return `${tone}: ${message}`; };
  assert.equal(toast({ result: "sent" }), "success: Continue sent");
  assert.equal(toast({ result: "used_up", until: new Date(2026, 9, 6, 18, 53).toISOString() }), "warning: Usage is still used up until 18:53");
  assert.equal(toast({ result: "used_up", until: new Date(2026, 9, 7, 9, 0).toISOString() }), "warning: Usage is still used up until Tmr 09:00");
  assert.equal(toast({ result: "used_up", until: new Date(2026, 9, 9, 9, 0).toISOString() }), "warning: Usage is still used up until Fri 09:00");
  assert.equal(toast({ result: "used_up", until: null }), "warning: Usage is still used up");
  assert.equal(toast({ result: "unverified", waiting: "auth" }), "warning: Couldn’t verify the account. Check the CLI login.");
  assert.equal(toast({ result: "unverified", waiting: "usage" }), "warning: Couldn’t verify usage. Try again shortly.");
  assert.equal(toast({ result: "canceled", reason: "new_message" }), "warning: Canceled · a newer message");
  assert.equal(toast({ result: "send_failed" }), "error: Couldn’t send the continue");
  assert.equal(toast({ result: "sending" }), "info: This agent is continuing now.");
  assert.equal(toast({ result: "changed" }), "info: This schedule already ran or changed.");
  assert.equal(toast({ result: "unavailable" }), "error: Auto Resume settings couldn’t be read.");
});

test("one bulk button turns everything off while anything is on", () => {
  assert.deepEqual(bulkAction([job({}), job({ enabled: false })]), { enabled: false, label: "Turn all off", shortLabel: "All off" });
  assert.deepEqual(bulkAction([job({ enabled: false }), job({ sending: true })]), { enabled: true, label: "Turn all on", shortLabel: "All on" });
});

test("every recorded result reads as one line", () => {
  const cases: Array<[HistoryOutcome, HistoryReason | undefined, string]> = [
    ["continued", undefined, "Continued"],
    ["send_failed", undefined, "Couldn’t send the continue"],
    ["skipped", undefined, "Skipped · turned off"],
    ["interrupted", undefined, "Dropped · interrupted by a restart"],
    ["gave_up", "attempts", "Gave up · limit hit 24 times in a row"],
    ["gave_up", "retries", "Gave up · stopped again after 3 retries"],
    ["gave_up", undefined, "Gave up"],
    ["canceled", "turn_started", "Canceled · turn started"],
    ["canceled", "new_message", "Canceled · a newer message"],
    ["canceled", "turn_finished", "Canceled · turn finished"],
    ["canceled", "agent_missing", "Canceled · agent not found"],
    ["canceled", "archived", "Canceled · agent archived"],
    ["canceled", "provider_changed", "Canceled · provider changed"],
    ["canceled", "model_changed", "Canceled · model changed"],
    ["canceled", "agent_busy", "Canceled · agent was busy"],
    ["canceled", "permission", "Canceled · waiting for permission"],
    ["canceled", "account_changed", "Canceled · account changed"],
    ["canceled", "api_route", "Canceled · API billing route"],
    ["canceled", "provider_off", "Canceled · provider turned off"],
    ["canceled", "unsupported_cli", "Canceled · unsupported CLI"],
    ["canceled", undefined, "Canceled"],
  ];
  for (const [outcome, reason, label] of cases) assert.equal(historyLabel({ outcome, reason }), label, `${outcome}/${reason}`);
  const canceledReasons = new Set(cases.filter(([outcome, reason]) => outcome === "canceled" && reason).map(([, reason]) => reason));
  const gaveUpReasons = new Set(["attempts", "retries"]);
  for (const reason of HistoryReasonSchema.options) {
    assert.ok(canceledReasons.has(reason) || gaveUpReasons.has(reason), `${reason} has a label`);
  }
});

test("a result Resume now started says so", () => {
  assert.equal(historyLabel({ outcome: "continued", trigger: "manual" }), "Continued · Resume now");
  assert.equal(historyLabel({ outcome: "canceled", reason: "new_message", trigger: "manual" }), "Canceled · a newer message · Resume now");
  assert.equal(historyLabel({ outcome: "send_failed", trigger: "manual" }), "Couldn’t send the continue · Resume now");
});

test("the collapsed header counts results by kind", () => {
  const outcomes: HistoryOutcome[] = ["continued", "canceled", "continued", "send_failed", "interrupted", "gave_up", "skipped"];
  assert.equal(historySummary(outcomes.map((outcome) => ({ outcome }))), "2 continued · 1 canceled · 1 skipped · 1 gave up · 1 failed · 1 dropped");
  assert.equal(historySummary([{ outcome: "canceled" }]), "1 canceled");
});

test("every history row is dated in local time", () => {
  assert.equal(historyDateLabel(new Date(2026, 9, 6, 0, 5).toISOString()), "Oct 6");
  assert.equal(historyDateLabel(new Date(2026, 9, 5, 23, 10).toISOString()), "Oct 5");
});

test("an empty prompt or the built-in one is saved as the default", () => {
  for (const text of ["", "  \n ", DEFAULT_CONTINUE_PROMPT, `\n${DEFAULT_CONTINUE_PROMPT}  `]) {
    assert.equal(promptToSave(text), null, JSON.stringify(text.slice(0, 20)));
  }
  assert.equal(promptToSave("  Keep going.\n"), "Keep going.");
  assert.equal(promptToSave(`${DEFAULT_CONTINUE_PROMPT} Run the tests.`), `${DEFAULT_CONTINUE_PROMPT} Run the tests.`);
});

test("the characters left show only near the limit", () => {
  assert.equal(charactersLeft(0, 2000), null);
  assert.equal(charactersLeft(1800, 2000), null);
  assert.equal(charactersLeft(1801, 2000), "199 characters left");
  assert.equal(charactersLeft(1999, 2000), "1 character left");
  assert.equal(charactersLeft(2000, 2000), "0 characters left");
  assert.equal(charactersLeft(3601, 4000), "399 characters left");
});

test("a note preview is one line, cut with an ellipsis", () => {
  assert.equal(notePreview("Run the tests.", 40), "Run the tests.");
  assert.equal(notePreview("  Run the tests.\n\n  Then push.  ", 40), "Run the tests. Then push.");
  assert.equal(notePreview("Run the migration tests first", 12), "Run the mig…");
  assert.equal(notePreview("Run the tests first", 9), "Run the…", "no space before the ellipsis");
  assert.equal(notePreview("x".repeat(2000), 80).length, 80);
});

test("a refused note says why", () => {
  assert.equal(noteRefusal("changed"), "This reservation changed. Review the time and save again.");
  assert.match(noteRefusal("sending"), /being sent/);
});
