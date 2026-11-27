import assert from 'node:assert/strict';
import { test } from 'node:test';
import { androidUi } from './android-device.mjs';
import { PLUGIN } from './core.mjs';
import { modelContinueRequests } from './native-fixture.mjs';
import { scheduleWire } from './schedule-wire.mjs';

const tree = (...nodes) => `<hierarchy>${nodes.map(attrs => `<node bounds="[1,1][10,10]" ${attrs}/>`).join('')}</hierarchy>`;
const field = text => `package="sh.paseo" class="android.widget.EditText" content-desc="Host" text="${text}"`;
const anrDialog = title => tree(`package="android" resource-id="android:id/alertTitle" text="${title}"`,
  'package="android" resource-id="android:id/aerr_wait" enabled="true" text="Wait"');

test('Android input completes after the intended field shows the entire value', async () => {
  const snapshots = [tree(field('')), tree(field('127.'), 'package="sh.paseo" text="127.0.0.1"'), tree(field('127.0.0.1'))];
  const commands = [];
  const device = androidUi({ dump: async () => snapshots.shift(), tapNode: async () => {},
    shell: async (...args) => commands.push(args), report: {} });
  await device.type('Host', '127.0.0.1');
  assert.equal(snapshots.length, 0);
  assert.deepEqual(commands.filter(([, kind]) => kind === 'text'), [['input', 'text', '127.0.0.1']]);
});

test('Android auto-dismisses only System UI ANRs and records other dialogs', async () => {
  const report = {};
  let taps = 0;
  let title = 'System UI isn’t responding';
  const device = androidUi({ dump: async () => anrDialog(title), tapNode: async () => { taps++; }, report });
  await device.nodes();
  assert.equal(report.anrDismissed, 1);
  title = 'Another app isn’t responding';
  await device.nodes();
  assert.deepEqual(report.anrDialogs, ['System UI isn’t responding', 'Another app isn’t responding']);
  title = 'Paseo isn’t responding';
  await assert.rejects(device.nodes(), /Paseo ANR/);
  assert.equal(taps, 1);
});

test('Android failed UI waits preserve the dump outcome', async () => {
  const report = {};
  let attempts = 0;
  const device = androidUi({ dump: async () => {
    attempts++;
    return 'ERROR: could not get idle state.';
  }, report });
  await assert.rejects(device.find('Direct connection', 10), /Android UI Direct connection/);
  assert.ok(attempts > 0);
  assert.deepEqual(report.uiWaitFailure.observations, { noHierarchy: attempts });
});

const send = (observer, fields) => observe(observer, 'sent', { pluginId: PLUGIN, ...fields });
const receive = (observer, type, payload) => observe(observer, 'received', { type, payload });

function observe(observer, direction, message) {
  observer.frame(direction, JSON.stringify({ type: 'session', message }));
}

function list(observer, requestId, ids = []) {
  send(observer, { type: 'plugin.rpc.invoke.request', requestId, method: 'auto-resume.list' });
  receive(observer, 'plugin.rpc.invoke.response', { requestId, output: { jobs: ids.map(id => ({ id })) } });
}

const revision = (observer, number) => receive(observer, 'plugin.rpc.event', {
  subscriptionId: 'live', event: { revision: number },
});

async function open() {
  const wire = scheduleWire();
  const observer = wire.connect({ replace: true });
  send(observer, { type: 'plugin.rpc.subscribe.request', requestId: 'subscribe', method: 'auto-resume.changes' });
  receive(observer, 'plugin.rpc.subscribe.response', { requestId: 'subscribe', subscriptionId: 'live' });
  list(observer, 'baseline');
  const client = await wire.ready(1);
  return { wire, observer, mark: wire.checkpoint(client, performance.now()) };
}

test('the list and event on the measured socket cannot prove display after socket replacement', async () => {
  const { wire, observer, mark } = await open();
  revision(observer, 1);
  list(observer, 'new-list', ['job']);
  wire.connect({ replace: true });
  assert.throws(() => wire.visibility(mark), /reconnected/);
});

test('an unrelated later revision does not erase an observed push', async () => {
  const { wire, observer, mark } = await open();
  revision(observer, 1);
  list(observer, 'new-list', ['job']);
  revision(observer, 2);
  assert.equal(wire.pushed(wire.visibility(mark), 'job').revision, 1);
});

test('a reconnect after visibility cannot invalidate evidence already captured', async () => {
  const { wire, observer, mark } = await open();
  revision(observer, 1);
  list(observer, 'new-list', ['job']);
  const visible = wire.visibility(mark);
  wire.connect({ replace: true });
  assert.equal(wire.pushed(visible, 'job').revision, 1);
});

test('a list requested before a schedule event cannot prove push even if a later request repeats it', async () => {
  const { wire, observer, mark } = await open();
  send(observer, { type: 'plugin.rpc.invoke.request', requestId: 'in-flight', method: 'auto-resume.list' });
  revision(observer, 1);
  receive(observer, 'plugin.rpc.invoke.response', { requestId: 'in-flight', output: { jobs: [{ id: 'job' }] } });
  list(observer, 'later', ['job']);
  assert.throws(() => wire.pushed(wire.visibility(mark), 'job'), /after a live schedule event/);
});

test('count the extra continue even when it hits the fixture limit window', () => {
  const seed = { api: 'claude', counted: true, mode: 'limit', last: '<system-reminder>fixture</system-reminder>\n Work on seed.' };
  const initial = { api: 'claude', counted: true, mode: 'text', last: 'Continue.' };
  const duplicate = { ...initial, mode: 'limit' };
  const countTokens = { ...initial, counted: false };
  const windows = [{ prompt: 'Work on seed.', from: 0, to: 1 }];
  assert.deepEqual(modelContinueRequests([seed, initial, duplicate, countTokens, seed], windows),
    [initial, duplicate, seed]);
});

test('only the exact Resume now invocation is evidence for the reservation', async () => {
  const { wire, observer, mark } = await open();
  const pin = { agentId: 'agent', id: 'reservation', dueAt: '2026-11-27T09:00:00.000Z' };
  const resume = (requestId, input, result) => {
    send(observer, { type: 'plugin.rpc.invoke.request', requestId, method: 'auto-resume.resume-now', input });
    receive(observer, 'plugin.rpc.invoke.response', { requestId, output: { result } });
  };
  resume('unrelated', { ...pin, id: 'another' }, 'used_up');
  resume('stale', { ...pin, dueAt: '2026-11-27T10:00:00.000Z' }, 'changed');
  assert.equal(wire.resumeResult(mark, pin), undefined);
  resume('expected', pin, 'sent');
  assert.equal(wire.resumeResult(mark, pin).result, 'sent');
});
