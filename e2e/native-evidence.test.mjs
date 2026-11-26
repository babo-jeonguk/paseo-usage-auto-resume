import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PLUGIN } from './core.mjs';
import { modelContinueRequests } from './native-fixture.mjs';
import { scheduleWire } from './schedule-wire.mjs';

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
  assert.deepEqual(modelContinueRequests([seed, initial, duplicate, countTokens], new Set(['Work on seed.'])),
    [initial, duplicate]);
});
