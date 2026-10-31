// --overload 1: real CLI final-error capture and Labs lifecycle against fake model APIs.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function runOverload(ctx) {
  const { suites, step, client, rpc, mkAgent, setModel, jobOf, readHistory, waitFor, sleep, API, out, daemonLog, paseoVersion, binaries, run, baseEnv } = ctx;
  const outcomes = async (id) => (await readFile(daemonLog, 'utf8')).split('\n').flatMap(line => {
    try {
      const row = JSON.parse(line), message = row.message ?? row.msg;
      const marker = '[usage-auto-resume] e2e-outcome ';
      if (!message?.startsWith(marker)) return [];
      const entry = JSON.parse(message.slice(marker.length));
      return entry.agentId === id ? [entry.outcome] : [];
    } catch { return []; }
  });
  const setLabs = async (overloadRetry) => {
    const current = await rpc('settings.resume.read');
    assert.equal(current.status, 'ready');
    const result = await rpc('settings.resume.write', { revision: current.revision, values: { ...current.values, overloadRetry, continuePrompt: 'CUSTOM MUST NOT BE SENT' } });
    assert.equal(result.status, 'saved');
  };
  for (const source of suites) {
    await step('overload-off', source, 'Labs off captures final result without a reservation', async () => {
      await setLabs(false);
      const a = await mkAgent('Overload off ' + source, source);
      await setModel(API[source], { mode: 'overload' });
      await client().sendAgentMessage(a.id, 'Reply with Done.');
      const outcome = await waitFor(async () => (await outcomes(a.id))[0], 'final ' + source, 600000);
      // Hook work is asynchronous; wait before asserting absence.
      await sleep(2000);
      assert.equal(await jobOf(a.id), undefined);
      const timeline = (await client().fetchAgentTimeline(a.id, { direction: 'tail', limit: 30 })).entries.map(e => e.item);
      const cliVersion = binaries[source] ? (await run(binaries[source], ['--version'], { env: baseEnv })).stdout.trim() : 'not supplied';
      await writeFile(join(out, `overload-${source}.json`), JSON.stringify({ provenance: { kind: 'real-cli-fake-model-api', paseoVersion, cliVersion, platform: process.platform }, source, outcome, timeline }, null, 2));
      return JSON.stringify(outcome);
    });
    await step('overload-on', source, 'Labs on schedules, Resume now sends the fixed prompt, completion clears', async () => {
      await setLabs(true);
      const a = await mkAgent('Overload on ' + source, source);
      await setModel(API[source], { mode: 'overload' });
      await client().sendAgentMessage(a.id, 'Reply with Done.');
      const job = await waitFor(async () => { const j = await jobOf(a.id); return j?.kind === 'overload' ? j : null; }, 'overload reservation', 600000);
      assert.equal(job.overloadStep, 1);
      await rpc('auto-resume.set-note', { agentId: a.id, id: job.id, note: 'Keep the existing edits.' });
      await setModel(API[source], { mode: 'text' });
      const before = (await outcomes(a.id)).length;
      assert.equal((await rpc('auto-resume.resume-now', { agentId: a.id, id: job.id, dueAt: job.dueAt })).result, 'sent');
      const outcome = await waitFor(async () => (await outcomes(a.id))[before], 'resumed turn end', 180000);
      const timeline = (await client().fetchAgentTimeline(a.id, { direction: 'tail', limit: 30 })).entries.map(e => e.item);
      const prompt = timeline.filter(i => i.type === 'user_message').at(-1)?.text;
      assert.ok(prompt.includes('Review existing edits, tool results, and subagent progress'));
      assert.ok(prompt.includes('Keep the existing edits.'));
      assert.ok(!prompt.includes('CUSTOM MUST NOT BE SENT'));
      await writeFile(join(out, `overload-resumed-${source}.json`), JSON.stringify({ outcome, timeline }, null, 2));
      assert.equal(outcome.kind, 'completed', 'Antigravity requires upstream F1 to be fixed; a replayed error is not hidden');
      await waitFor(async () => !(await jobOf(a.id)), 'completed job cleared');
      assert.ok((await readHistory()).some(e => e.agentId === a.id && e.outcome === 'continued' && e.kind === 'overload'));
      return 'fixed prompt + note, one send, cleared';
    });
    await step('overload-disable', source, 'switching Labs off immediately cancels pending retries and enabling does not restore them', async () => {
      const a = await mkAgent('Overload disable ' + source, source);
      await setModel(API[source], { mode: 'overload' });
      await client().sendAgentMessage(a.id, 'Reply with Done.');
      const job = await waitFor(async () => { const j = await jobOf(a.id); return j?.kind === 'overload' ? j : null; }, 'pending retry', 600000);
      await rpc('auto-resume.set-enabled', { agentId: a.id, id: job.id, dueAt: job.dueAt, enabled: false });
      await setLabs(false);
      await waitFor(async () => !(await jobOf(a.id)), 'immediate cancellation');
      assert.ok((await readHistory()).some(e => e.agentId === a.id && e.reason === 'overload_off'));
      await setLabs(true);
      assert.equal(await jobOf(a.id), undefined);
      return 'canceled disabled pending row via settings subscription, not restored';
    });
    // Pending rows from a failed upstream check must not run unattended later in this suite.
    await setLabs(false);
  }
}
