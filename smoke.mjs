import { spawn } from 'node:child_process';

const server = spawn(process.execPath, ['src/index.mjs'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });
server.stderr.on('data', (d) => process.stderr.write('[server stderr] ' + d));

const frame = (obj) => { const s = JSON.stringify(obj); return `Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`; };

let buf = Buffer.alloc(0);
const responses = [];
server.stdout.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    const idx = buf.toString('latin1').indexOf('\r\n\r\n');
    if (idx === -1) break;
    const m = buf.toString('latin1').slice(0, idx).match(/Content-Length:\s*(\d+)/i);
    if (!m) { buf = buf.slice(idx + 4); continue; }
    const len = parseInt(m[1], 10);
    const start = idx + 4;
    if (buf.length < start + len) break;
    const body = buf.slice(start, start + len).toString('utf8');
    buf = buf.slice(start + len);
    try { responses.push(JSON.parse(body)); } catch {}
  }
});

setTimeout(() => {
  server.stdin.write(frame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } }));
  server.stdin.write(frame({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  server.stdin.write(frame({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
  server.stdin.write(frame({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'deepseek_models', arguments: {} } }));
}, 200);

setTimeout(() => {
  const r = (id) => responses.find((x) => x.id === id);
  console.log('1) initialize -> serverInfo:', JSON.stringify(r(1)?.result?.serverInfo));
  console.log('2) tools/list -> tools:', (r(2)?.result?.tools || []).map((t) => t.name).join(', '));
  const txt = (r(3)?.result?.content?.[0]?.text || '').replace(/\x1b\[[0-9;]*m/g, '');
  console.log('3) tools/call deepseek_models -> ok:', !!r(3)?.result?.content, '| first models line:', txt.split('\n').find((l) => l.includes('deepseek')) || '(none)');
  server.kill('SIGTERM');
  process.exit(0);
}, 1500);
