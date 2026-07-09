import { spawn } from 'child_process';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bridgePath = join(__dirname, '../bridge.mjs');

async function runTest(url, inputLines, expectedPayloads, expectedStderrLines) {
    return new Promise((resolve, reject) => {
        const server = createServer();
        const wss = new WebSocketServer({ server });
        const received = [];
        let connected = false;
        
        wss.on('connection', (ws) => {
            connected = true;
            ws.on('message', (msg) => {
                received.push(msg.toString());
            });
        });

        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            // Build the URL, injecting the port if we have a placeholder
            const fullUrl = url.replace('PORT', port);
            
            const child = spawn(process.execPath, [bridgePath, fullUrl], {
                stdio: ['pipe', 'pipe', 'pipe']
            });

            let stderrOutput = '';
            child.stderr.on('data', (d) => {
                const chunk = d.toString();
                stderrOutput += chunk;
                if (chunk.includes('ws open')) {
                    setTimeout(() => {
                        child.stdin.end();
                    }, 50);
                }
            });

            // Send lines
            for (const line of inputLines) {
                child.stdin.write(line + '\n');
            }

            child.on('close', () => {
                server.close(() => {
                    try {
                        assert.deepStrictEqual(received, expectedPayloads, `Payloads do not match. Stderr: ${stderrOutput}`);
                        for (const sl of expectedStderrLines) {
                            assert.ok(stderrOutput.includes(sl), `Expected stderr to include: ${sl}\nGot: ${stderrOutput}`);
                        }
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                });
            });
        });
    });
}

import { test, expect } from 'vitest';

test('bridge handles contractHash correctly', async () => {
    // Test 1: Injects contractHash when present in URL and missing in payload
    await runTest(
        'ws://127.0.0.1:PORT?contractHash=abcdef',
        ['{"method":"initialize","params":{"clientInfo":{}}}'],
        ['{"method":"initialize","params":{"clientInfo":{"contractHash":"abcdef"}}}'],
        ['[mcp-bridge] injected contractHash from URL']
    );

    // Test 2: Passes through unchanged if contractHash already present in payload
    await runTest(
        'ws://127.0.0.1:PORT?contractHash=abcdef',
        ['{"method":"initialize","params":{"clientInfo":{"contractHash":"123456"}}}'],
        ['{"method":"initialize","params":{"clientInfo":{"contractHash":"123456"}}}'],
        []
    );

    // Test 3: Passes through unchanged if URL lacks contractHash (and payload lacks it) + logs warning
    await runTest(
        'ws://127.0.0.1:PORT?otherParam=true',
        ['{"method":"initialize","params":{"clientInfo":{}}}'],
        ['{"method":"initialize","params":{"clientInfo":{}}}'],
        ['[mcp-bridge] URL lacks contractHash, relaying unchanged']
    );

    // Test 4: Leaves non-initialize traffic unchanged
    await runTest(
        'ws://127.0.0.1:PORT?contractHash=abcdef',
        ['{"method":"some_other_method","params":{}}'],
        ['{"method":"some_other_method","params":{}}'],
        []
    );
});
