#!/usr/bin/env node
// Standalone stdio <-> WebSocket MCP bridge.
import { createInterface } from 'readline';
const url = process.argv[2];
const log = (...a) => process.stderr.write('[mcp-bridge] ' + a.join(' ') + '\n');
if (!url) {
    log('FATAL: missing WebSocket URL argument');
    process.exit(2);
}
let wsOpen = false;
const outbox = []; // stdin lines buffered until the socket is open
const ws = new WebSocket(url);
ws.addEventListener('open', () => {
    wsOpen = true;
    log('ws open ->', url);
    for (const line of outbox.splice(0))
        ws.send(line);
});
ws.addEventListener('message', (ev) => {
    const data = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
    process.stdout.write(data.endsWith('\n') ? data : data + '\n');
});
ws.addEventListener('close', (ev) => {
    log('ws close', ev.code ?? '');
    const isNormal = !ev.code || ev.code === 1000 || ev.code === 1001 || ev.code === 1005;
    process.exit(isNormal ? 0 : 1);
});
ws.addEventListener('error', (ev) => {
    const errMsg = ev?.message || String(ev?.error || ev || '');
    log('ws error', errMsg);
    process.exit(1);
});
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
    const s = line.trim();
    if (!s)
        return;
    if (wsOpen)
        ws.send(s);
    else
        outbox.push(s);
});
rl.on('close', () => {
    log('stdin closed');
    try {
        ws.close();
    }
    catch { /* noop */ }
});
