// Fake model APIs for the Usage Auto Resume e2e: Anthropic Messages, OpenAI Responses, Gemini
// streamGenerateContent, on ONE port. Every request is logged (JSONL) so the harness can count them.
// Control file (JSON, re-read per request), one section per API:
//   { "claude": {"mode":"limit","resetInSec":5400}, "codex": {"mode":"limit","resetInSec":7200}, "agy": {"mode":"limit"} }
//   mode: "text" (default, reply c.text||"Done.") | "limit" | "notice" (claude only: notice text as a normal reply)
// usage: node fake-models.mjs <port> <controlFile> <logFile>
import { createServer } from 'node:http';
import { readFileSync, appendFileSync } from 'node:fs';
const [port, controlFile, logFile] = process.argv.slice(2);
const ctl = () => { try { return JSON.parse(readFileSync(controlFile, 'utf8')); } catch { return {}; } };
const textOf = (content) => typeof content === 'string' ? content
  : (content ?? []).map((b) => b.text ?? b.input_text ?? '').filter(Boolean).join(' ');
createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let parsed = {}; try { parsed = JSON.parse(body); } catch {}
    const url = req.url;
    const api = url.startsWith('/v1/messages') ? 'claude' : url.startsWith('/v1/responses') ? 'codex' : url.includes(':streamGenerateContent') || url.includes(':generateContent') ? 'agy' : 'other';
    let last = '';
    try {
      if (api === 'claude') last = textOf((parsed.messages ?? []).filter((m) => m.role === 'user').at(-1)?.content);
      if (api === 'codex') last = textOf((parsed.input ?? []).filter((m) => m.role === 'user').at(-1)?.content);
      if (api === 'agy') last = textOf((parsed.contents ?? []).filter((m) => m.role === 'user').at(-1)?.parts);
    } catch {}
    let turns = [];
    try { if (api === 'agy') turns = (parsed.contents ?? []).filter((m) => m.role === 'user').map((m) => textOf(m.parts).slice(0, 1500)).slice(-6); } catch {}
    const c = ctl()[api] ?? {};
    const mode = c.mode ?? 'text';
    const counted = api !== 'other' && !url.includes('count_tokens');
    if (logFile) appendFileSync(logFile, JSON.stringify({ t: new Date().toISOString(), api, counted, method: req.method, url: url.slice(0, 80), mode, last: last.slice(-8000), turns }) + '\n');
    const json = (status, headers, obj) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
    if (api === 'other') return json(404, {}, { error: 'fixture' });
    if (url.includes('count_tokens')) return json(200, {}, { input_tokens: 10 });
    const text = c.text ?? 'Done.';
    const sse = (events) => { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); for (const [ev, data] of events) res.write((ev ? `event: ${ev}\n` : '') + `data: ${JSON.stringify(data)}\n\n`); res.end(); };

    if (api === 'claude') {
      if (mode === 'limit') {
        const reset = Math.floor(Date.now() / 1000) + (c.resetInSec ?? 5400);
        return json(429, {
          'retry-after': String(c.resetInSec ?? 5400),
          'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-reset': String(reset),
          'anthropic-ratelimit-unified-representative-claim': c.claim ?? 'five_hour',
          'anthropic-ratelimit-unified-5h-status': 'rejected', 'anthropic-ratelimit-unified-5h-utilization': '1.0', 'anthropic-ratelimit-unified-5h-reset': String(reset),
          'anthropic-ratelimit-unified-7d-status': 'allowed', 'anthropic-ratelimit-unified-7d-utilization': '0.2', 'anthropic-ratelimit-unified-7d-reset': String(reset + 259200),
          'anthropic-ratelimit-unified-overage-status': 'rejected', 'anthropic-ratelimit-unified-overage-disabled-reason': 'overage_not_provisioned',
          'anthropic-ratelimit-unified-fallback': 'unavailable',
        }, { type: 'error', error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your per-minute rate limit' } });
      }
      const reply = mode === 'notice' ? (c.text ?? "You've hit your limit · resets 3pm (Asia/Seoul)") : text;
      const model = parsed.model ?? 'claude-fixture', id = 'msg_fixture_' + Date.now();
      const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      if (!parsed.stream) return json(200, {}, { id, type: 'message', role: 'assistant', model, content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', stop_sequence: null, usage });
      return sse([
        ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
        ['message_stop', { type: 'message_stop' }],
      ]);
    }
    if (api === 'codex') {
      if (mode === 'limit') {
        const resetIn = c.resetInSec ?? 7200;
        return json(429, {}, { error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', plan_type: 'plus', resets_at: Math.floor(Date.now() / 1000) + resetIn, resets_in_seconds: resetIn } });
      }
      const rid = 'resp_' + Date.now(), mid = 'msg_' + Date.now();
      return sse([
        ['response.created', { type: 'response.created', response: { id: rid } }],
        ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: mid, role: 'assistant', content: [] } }],
        ['response.output_text.delta', { type: 'response.output_text.delta', item_id: mid, output_index: 0, content_index: 0, delta: text }],
        ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: mid, role: 'assistant', content: [{ type: 'output_text', text }] } }],
        ['response.completed', { type: 'response.completed', response: { id: rid, usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } }],
      ]);
    }
    // agy / Gemini
    if (mode === 'limit') {
      const h = c.resetText ?? '2h';
      return json(429, {}, { error: { code: 429, message: `Individual quota reached. Resets in ${h}.`, status: 'RESOURCE_EXHAUSTED' } });
    }
    const chunk = { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }, modelVersion: 'fixture' };
    if (url.includes(':streamGenerateContent')) return sse([[null, chunk]]);
    return json(200, {}, chunk);
  });
}).listen(Number(port), '127.0.0.1', () => console.log('fake models on', port));
