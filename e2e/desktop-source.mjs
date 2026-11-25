import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cliBin, connectToDaemon, freePort, githubPluginUrl, installPlugin, killTree, nativeRun, options,
  paseoCommand, readJson, revisionOf, run, runHome, running, SOURCE, spawnLogged } from './core.mjs';
import { nativeDefaults } from './native-fixture.mjs';

const args = options(['cli'], { ...nativeDefaults, source: SOURCE });
await nativeRun('desktop-source', args, async ({ root, out, report, artifacts, dispose, check }) => {
  assert.match(args.source, /^git:[\w.-]+\/[\w.-]+$/, 'Specify a GitHub plugin source as git:owner/repo');
  const { home, work, env } = await runHome(root, args.path);
  const cli = resolve(args.cli);
  const version = (await readJson(join(cli, 'package.json'))).version;
  const target = `127.0.0.1:${await freePort()}`;
  const environment = { ...env, PASEO_HOME: home, PASEO_LISTEN: target, PASEO_RELAY_ENABLED: 'false' };
  const paseo = paseoCommand(() => cliBin(cli), home, environment);
  const stop = paseoCommand(() => cliBin(cli), home, environment, { timeout: 30_000 });
  await writeFile(join(home, 'config.json'), JSON.stringify({ version: 1, pluginsEnabled: true,
    daemon: { listen: target, relay: { enabled: false }, mcp: { enabled: false }, usage: { enabled: false } },
    features: { webUi: { enabled: false } }, agents: { resumeOnStartup: false } }));

  await check('Install and load the requested GitHub revision in an isolated Paseo home', async () => {
    const log = join(root, 'daemon.log');
    artifacts['daemon.log'] = log;
    const daemon = spawnLogged(process.execPath, ['--no-maglev', cliBin(cli), 'daemon', 'run', '--home', home],
      { env: environment, cwd: work, log });
    dispose(async () => {
      try {
        if (running(daemon)) await stop('daemon', 'stop');
      } finally { await killTree(daemon); }
    });
    const client = await connectToDaemon(cli, version, home, target, () => running(daemon));
    await client.close();
    report.revision = revisionOf(await installPlugin(paseo, args.source, args.to, environment));
    return { paseo: version, revision: report.revision };
  });

  await check('Stage the verified commit for the offline Desktop run', async () => {
    const repository = join(out, 'source.git');
    const git = (...command) => run('git', command, { cwd: work, env, timeout: 120_000, windowsHide: true });
    await git('init', '--bare', '--initial-branch=main', repository);
    await git('-C', repository, 'fetch', '--no-tags', '--depth=1', githubPluginUrl(args.source), `${report.revision}:refs/heads/main`);
    const { stdout } = await git('-C', repository, 'rev-parse', 'HEAD');
    assert.equal(stdout.trim(), report.revision);
    report.localSource = pathToFileURL(repository).href;
    return { source: report.localSource, ref: report.revision };
  });
});
