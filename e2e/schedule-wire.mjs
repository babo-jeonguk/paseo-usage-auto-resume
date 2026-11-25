import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { listen, PLUGIN, waitFor } from './core.mjs';

const scheduleReads = new Set(['auto-resume.list', 'auto-resume.history']);

// Observe the public Paseo session messages. Keep only schedule calls and their replies.
export function scheduleWire() {
  const connections = new Set();
  function connect() {
    const state = { pending: new Map(), subscriptions: new Set(), messages: [] };
    connections.add(state);
    function frame(direction, data) {
      let envelope;
      try { envelope = JSON.parse(String(data)); } catch { return; }
      const message = envelope?.type === 'session' ? envelope.message : null;
      if (!message) return;
      const { type, payload } = message;
      if (direction === 'sent') {
        if (type === 'subscription.release.request') state.subscriptions.delete(message.subscriptionId);
        if (message.pluginId !== PLUGIN) return;
        if (type === 'plugin.rpc.subscribe.request' && message.method === 'auto-resume.changes' ||
          type === 'plugin.rpc.invoke.request' && scheduleReads.has(message.method)) {
          state.pending.set(message.requestId, message.method);
        }
        return;
      }
      if (type === 'plugin.rpc.closed') state.subscriptions.delete(payload?.subscriptionId);
      if (type === 'plugin.rpc.event' && state.subscriptions.has(payload?.subscriptionId)) {
        state.messages.push({ subscriptionId: payload.subscriptionId, revision: payload.event?.revision, at: performance.now() });
      }
      const method = state.pending.get(payload?.requestId);
      if (!method) return;
      state.pending.delete(payload.requestId);
      if (type === 'plugin.rpc.subscribe.response') state.subscriptions.add(payload.subscriptionId);
      if (type === 'plugin.rpc.invoke.response') state.messages.push({ method, jobs: payload.output?.jobs, at: performance.now() });
    }
    return { frame, close: () => connections.delete(state) };
  }
  const ready = minimum => waitFor(() => [...connections].find(state => state.subscriptions.size >= minimum &&
    !state.pending.size && state.messages.some(message => message.method === 'auto-resume.list')),
  `live schedule subscriptions (${minimum}) and completed initial list`, 60_000, 100);
  const settled = state => waitFor(() => connections.has(state) && !state.pending.size, 'in-flight schedule reads to finish', 15_000, 100);
  const checkpoint = state => {
    assert(connections.has(state) && !state.pending.size, 'Checkpoint requires a connected, settled schedule observer');
    return { state, since: state.messages.length, subscriptions: new Set(state.subscriptions) };
  };
  function messagesSince({ state, since, subscriptions }) {
    assert(connections.has(state), 'Paseo UI reconnected during the measurement');
    assert.deepEqual(state.subscriptions, subscriptions, 'Schedule subscriptions changed during the measurement');
    return state.messages.slice(since);
  }
  return {
    connect, ready, settled, checkpoint, messagesSince,
    pushed(mark, agentId) {
      const messages = messagesSince(mark);
      const eventIndex = messages.findIndex(message => Number.isSafeInteger(message.revision));
      const listIndex = messages.findIndex(message => message.jobs?.some(job => job.agentId === agentId));
      assert(eventIndex >= 0 && listIndex > eventIndex, 'The UI must receive a live schedule event before a list response containing the new reservation');
      return { revision: messages[eventIndex].revision, eventReceivedAt: messages[eventIndex].at, listReceivedAt: messages[listIndex].at };
    },
  };
}

// ADB reverse can target this local observer without changing the app's session protocol.
export async function observeAndroidWire(cli, target, wire) {
  const { WebSocket, WebSocketServer } = createRequire(join(cli, 'package.json'))('ws');
  const upstreams = new Set();
  const websocket = new WebSocketServer({ noServer: true });
  const server = createServer((request, response) => {
    const forward = httpRequest(new URL(`http://${target}`), {
      method: request.method, path: request.url, headers: { ...request.headers, host: target }, timeout: 10_000,
    }, reply => {
      response.writeHead(reply.statusCode, reply.headers);
      reply.pipe(response);
    });
    forward.on('timeout', () => forward.destroy());
    forward.on('error', () => {
      if (response.headersSent) response.destroy();
      else response.writeHead(502).end();
    });
    response.on('close', () => forward.destroy());
    request.pipe(forward);
  });
  server.on('upgrade', (request, socket, head) => {
    if (!/^\/ws(?:\?|$)/.test(request.url)) { socket.destroy(); return; }
    const upstream = new WebSocket(`ws://${target}${request.url}`, { handshakeTimeout: 10_000 });
    upstreams.add(upstream);
    upstream.once('close', () => upstreams.delete(upstream));
    upstream.on('error', () => socket.destroy());
    socket.once('close', () => upstream.terminate());
    upstream.once('open', () => {
      if (socket.destroyed) return;
      websocket.handleUpgrade(request, socket, head, downstream => {
        const observer = wire.connect();
        downstream.once('close', observer.close);
        downstream.on('error', () => upstream.terminate());
        upstream.once('close', () => downstream.terminate());
        for (const [from, to, direction] of [[downstream, upstream, 'sent'], [upstream, downstream, 'received']]) {
          from.on('message', (data, binary) => {
            if (!binary) observer.frame(direction, data);
            if (to.readyState === WebSocket.OPEN) to.send(data, { binary });
          });
        }
      });
    });
  });
  const listener = await listen(server);
  return { port: listener.port, async close() {
    for (const upstream of upstreams) upstream.terminate();
    await listener.close();
  } };
}
