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
    const errMsg = ev?.error?.stack || ev?.message || String(ev?.error || ev || '');
    log('ws error', errMsg);
    process.exit(1);
});
let contractHashFromUrl = null;
try {
    contractHashFromUrl = new URL(url).searchParams.get('contractHash');
} catch (e) {
    // Ignore URL parse errors
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
    const s = line.trim();
    if (!s)
        return;

    let payload = s;
    if (s.includes('"method":"initialize"') || s.includes('"method": "initialize"')) {
        try {
            const parsed = JSON.parse(s);
            if (parsed.method === 'initialize' && parsed.params && parsed.params.clientInfo) {
                if (!parsed.params.clientInfo.contractHash) {
                    if (contractHashFromUrl) {
                        parsed.params.clientInfo.contractHash = contractHashFromUrl;
                        payload = JSON.stringify(parsed);
                        log('injected contractHash from URL');
                    } else {
                        log('URL lacks contractHash, relaying unchanged');
                    }
                }
            }
        } catch {
            // ignore parse errors, pass through unchanged
        }
    }

    if (wsOpen)
        ws.send(payload);
    else
        outbox.push(payload);
});
rl.on('close', () => {
    log('stdin closed');
    try {
        ws.close();
    }
    catch { /* noop */ }
});
