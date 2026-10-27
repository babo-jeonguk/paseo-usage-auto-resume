import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
const [port, log] = process.argv.slice(2);
const s = createServer((req, res) => { appendFileSync(log, `HTTP ${req.method} ${req.url}\n`); res.writeHead(502); res.end('blocked'); });
s.on('connect', (req, sock) => { appendFileSync(log, `CONNECT ${req.url}\n`); sock.end('HTTP/1.1 502 Blocked\r\n\r\n'); });
s.listen(Number(port), '127.0.0.1');
