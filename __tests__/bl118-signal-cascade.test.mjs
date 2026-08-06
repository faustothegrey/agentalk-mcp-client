// BL-118 — a signal to llm-agent must take the provider CLI down with it.
//
// terminateAgent (lib/agent-launcher.mjs:201) is `child.kill('SIGTERM')` on a SINGLE pid, not a
// process-group kill, and the provider CLI is a GRANDCHILD spawned inside executor.initialize()
// (lib/executor-runtime.mjs:171). Before the handler in llm-agent.mjs, nothing signalled it: a cap
// kill terminated the supervisor of the work and left the thing actually spending tokens alive.
//
// ⚠️ WHY THIS FILE EXISTS SEPARATELY FROM THE BL-096 HARNESS — read before "simplifying" them together.
// bl096-midwork-interruption's fake bridge self-exits after 25s as a leak guard. That guard MASKS
// exactly this behaviour: an orphan there dies on its own and the suite looks clean either way. A bar
// built on it would pass whether or not the cascade works. So this bridge lives for 60s and the
// assertion window is ~2s — the orphan has no way to disappear on its own inside it.

import { afterEach, describe, expect, it } from 'vitest';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { WebSocketServer } from 'ws';

const once = (em, ev) => new Promise((r) => em.once(ev, r));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return true;
    await sleep(25);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
}

// Minimal MCP stand-in: llm-agent exits if it cannot connect, so it needs a real socket to attach to.
// It answers `initialize` and then simply holds `await_turn` — the worker never needs a turn here,
// because the provider CLI is spawned at initialize(), before any turn exists.
async function createIdleMcp() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'initialize') {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'mock', version: '1.0' } } }));
      } else if (msg.method === 'tools/call' && msg.params?.name !== 'await_turn') {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok' }] } }));
      }
      // await_turn is deliberately never answered — the agent parks, exactly as in a real idle attach.
    });
  });
  return { wss, port: wss.address().port };
}

describe('BL-118 — a signal cascades to the provider CLI', () => {
  const cleanups = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) { try { await fn(); } catch { /* best effort */ } }
  });

  it('SIGTERM to llm-agent kills the provider CLI it spawned — no orphan left behind', async () => {
    const mcp = await createIdleMcp();
    cleanups.push(() => mcp.wss.close());

    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'bl118-'));
    cleanups.push(() => rmSync(tempDir, { recursive: true, force: true }));

    // The stand-in provider CLI: announce our pid, then stay alive far longer than the assertion
    // window so that surviving is observable rather than a timing artefact.
    const pidFile = path.join(tempDir, 'provider.pid');
    const bridge = path.join(tempDir, 'provider-bridge.cjs');
    writeFileSync(bridge, `
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid), 'utf8');
require('readline').createInterface({ input: process.stdin, output: process.stdout })
  .on('line', () => {});
setInterval(() => {}, 1 << 30);
setTimeout(() => process.exit(0), 60000);   // long stop — must NOT be what ends this process
`, 'utf8');

    const agent = spawn(process.execPath, [
      path.resolve(process.cwd(), 'llm-agent.mjs'),
      '--provider', 'claude', '--execution-mode', 'persistent', '--agentId', 'bl118-worker',
    ], {
      cwd: tempDir,
      env: {
        ...process.env,
        AGENTTALK_PERSISTENT_MCP_URL: `ws://127.0.0.1:${mcp.port}/`,
        AGENTTALK_PERSISTENT_COMMAND_JSON: JSON.stringify({ command: process.execPath, args: [bridge] }),
      },
      stdio: 'ignore',
    });
    // Safety net: if the assertion fails, do not strand either process on the dev box.
    cleanups.push(() => {
      try { process.kill(agent.pid, 'SIGKILL'); } catch { /* gone */ }
      if (existsSync(pidFile)) { try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* gone */ } }
    });

    await waitFor(async () => existsSync(pidFile), 15000, 'the provider CLI to be spawned');
    const providerPid = Number(readFileSync(pidFile, 'utf8'));
    expect(Number.isInteger(providerPid)).toBe(true);

    // Precondition, asserted rather than assumed: both are up before we signal anything. Without
    // this a dead-on-arrival provider would make the cascade look like it worked.
    expect(alive(providerPid)).toBe(true);
    expect(alive(agent.pid)).toBe(true);

    // Exactly what terminateAgent does — a single-pid SIGTERM, no process group.
    process.kill(agent.pid, 'SIGTERM');

    // THE BAR. 2s is far inside the bridge's own 60s stop, so a pass cannot be it timing out.
    await waitFor(async () => !alive(providerPid), 2000, 'the provider CLI to die with its agent');
    expect(alive(providerPid)).toBe(false);
  }, 30000);
});
