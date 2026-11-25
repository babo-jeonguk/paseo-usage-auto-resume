import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function refusingProxy(log) {
  const server = createServer((req, res) => {
    appendFileSync(log, `HTTP ${req.method} ${req.url}\n`);
    res.writeHead(502).end('blocked');
  });
  server.on('connect', (req, socket) => {
    appendFileSync(log, `CONNECT ${req.url}\n`);
    socket.on('error', () => socket.destroy());
    socket.end('HTTP/1.1 502 Blocked\r\n\r\n');
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [port, log] = process.argv.slice(2);
  refusingProxy(log).listen(Number(port), '127.0.0.1');
}
