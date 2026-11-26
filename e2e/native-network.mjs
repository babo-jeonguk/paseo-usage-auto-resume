import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';

export function isOfflineRegistryFailure(entry) {
  const message = entry.error?.message;
  return entry.module === 'session' && entry.message === 'Error handling message' &&
    entry.error?.stack?.includes('at async listRegistryPlugins (') &&
    /^Could not reach plugin registry https:\/\/plugins\.paseo\.sh\/index\.json\. Retry later\.: fetch failed: getaddrinfo (?:EAI_AGAIN|ENOTFOUND) plugins\.paseo\.sh$/.test(message);
}

export async function assertNativeOffline() {
  const external = Object.entries(networkInterfaces()).filter(([, addresses]) => addresses.some(address => !address.internal));
  assert.deepEqual(external.map(([name]) => name), [], 'Native E2E requires a loopback-only environment');
  if (process.platform === 'linux') {
    const devices = (await readFile('/proc/net/dev', 'utf8')).trim().split('\n').slice(2);
    assert.deepEqual(devices.map(line => line.split(':')[0].trim()), ['lo'], 'Run Desktop E2E in a network namespace with only loopback');
  }

  const probes = {};
  // Numeric documentation addresses probe the kernel directly without DNS or proxy settings.
  for (const host of ['192.0.2.1', '2001:db8::1']) {
    const result = await new Promise((resolve, reject) => {
      const socket = connect({ host, port: 443 });
      socket.once('connect', () => socket.destroy(new Error('Direct TCP escaped native E2E network isolation')));
      socket.once('error', error => error.code ? resolve(error.code) : reject(error));
      socket.setTimeout(3000, () => socket.destroy(new Error('Kernel did not reject direct TCP immediately')));
    });
    assert(['ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(result), `Unexpected direct TCP result for ${host}: ${result}`);
    probes[host] = result;
  }
  return probes;
}
