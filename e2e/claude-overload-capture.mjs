// Captures how Claude Code renders each of its overload end paths, against the local fake Messages
// API only (no account, no remote model). The Paseo e2e reaches one path; the CLI has several.
// usage: node e2e/claude-overload-capture.mjs --out <dir> [--claude <binary>] [--port 39977]
//   writes <out>/claude-overload-<case>.json: CLI version, case settings and the final assistant text.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({ options: { out: { type: 'string' }, claude: { type: 'string', default: 'claude' }, port: { type: 'string', default: '39977' } } });
if (!args.out) throw new Error('--out is required');
const here = dirname(fileURLToPath(import.meta.url));

// Each case is one way the CLI ends a turn on an overload.
const CASES = [
  // The 529 itself, once retries are spent (the Paseo e2e sets no retries; the default is 10). A
  // claude.ai OAuth login spends every retry even on Opus.
  { name: '529-no-retries', mode: 'overload', model: 'sonnet', env: { CLAUDE_CODE_MAX_RETRIES: '0' } },
  { name: '529-default-retries', mode: 'overload', model: 'opus', env: {} },
  // An overloaded_error inside a stream that began with HTTP 200.
  { name: 'stream-overload', mode: 'overload-stream', model: 'sonnet', env: { CLAUDE_CODE_MAX_RETRIES: '0' } },
  { name: 'stream-overload-default-retries', mode: 'overload-stream', model: 'sonnet', env: {} },
  // The CLI's give-up after repeated 529s, documented for an API key on Opus. A claude.ai OAuth
  // login, as the cases above and the Paseo e2e use, spends every retry instead.
  { name: 'repeated-529', mode: 'overload', model: 'opus', auth: { ANTHROPIC_API_KEY: 'sk-ant-fixture-only' } },
];

const root = await mkdtemp(join(tmpdir(), 'claude-overload-'));
const control = join(root, 'control.json');
const run = (command, argv, env) => new Promise((resolve) => {
  const child = spawn(command, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.on('close', (code) => resolve({ code, stdout }));
});
const server = spawn(process.execPath, [join(here, 'fake-models.mjs'), args.port, control, join(root, 'requests.jsonl')], { stdio: 'ignore' });
try {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await mkdir(args.out, { recursive: true });
  const version = (await run(args.claude, ['--version'], { PATH: process.env.PATH })).stdout.trim();
  for (const c of CASES) {
    await writeFile(control, JSON.stringify({ claude: { mode: c.mode } }));
    const home = join(root, c.name);
    await mkdir(join(home, 'config'), { recursive: true });
    const env = {
      PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: join(home, 'config'), ...(c.auth ?? { CLAUDE_CODE_OAUTH_TOKEN: 'e2e-fixture-only' }),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${args.port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1', DISABLE_ERROR_REPORTING: '1', ...c.env,
    };
    const { stdout } = await run(args.claude, ['-p', 'Reply with Done.', '--output-format', 'stream-json', '--verbose', '--model', c.model], env);
    const events = stdout.split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
    const assistant = events.filter((e) => e.type === 'assistant').at(-1);
    const result = events.find((e) => e.type === 'result');
    const text = (assistant?.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const requests = (await readFile(join(root, 'requests.jsonl'), 'utf8').catch(() => '')).split('\n').filter((l) => l.includes('"counted":true')).length;
    await writeFile(join(root, 'requests.jsonl'), '');
    const capture = { cliVersion: version, case: c, requests, resultSubtype: result?.subtype, apiErrorStatus: result?.api_error_status, text };
    await writeFile(join(args.out, `claude-overload-${c.name}.json`), JSON.stringify(capture, null, 2));
    console.log(`${c.name}: ${requests} requests; ${text}`);
  }
} finally {
  server.kill();
  await rm(root, { recursive: true, force: true });
}
