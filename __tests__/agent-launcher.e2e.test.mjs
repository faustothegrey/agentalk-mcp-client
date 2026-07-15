// End-to-end test for the agent-launcher.
//
// Exercises the REAL chain with no mocking of the launcher itself:
//   real launcher HTTP server (real child_process.spawn + real fetch)
//     -> real HTTP calls to an orchestrator stub (create + start)
//     -> real llm-agent harness spawned
//     -> real WebSocket attach to a mock MCP server (initialize + await_turn)
//
// The only stand-ins are the two things the launcher TALKS TO, exercised for real over
// real sockets: the orchestrator (a faithful HTTP stub that echoes the id like server.ts)
// and the MCP server (accepts the attach, like exec-rpc.test.ts). The provider CLI is
// replaced by a fake bridge via AGENTTALK_PERSISTENT_COMMAND_JSON — the same technique the
// existing exec-rpc E2E uses — because a real CLI turn is out of the launcher's scope; the
// launcher's job ends when the harness attaches.

import { afterEach, describe, expect, it } from 'vitest';
import http from 'http';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { WebSocketServer } from 'ws';
import { createLauncherCore, createLauncherServer } from '../lib/agent-launcher.mjs';

function once(server, event) {
  return new Promise((resolve) => server.once(event, resolve));
}

// Mock MCP WS server: accepts the attach, auto-replies to initialize, and resolves a
// promise the moment the harness pulls its first turn (await_turn) — proof of attach.
async function createMockMcpServer() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  const state = { initialize: null, awaitTurnSeen: false };
  let resolveAttached;
  const attached = new Promise((r) => (resolveAttached = r));
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'initialize') {
        state.initialize = msg;
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'mock', version: '1.0' } } }));
      }
      if (msg.method === 'tools/call' && msg.params?.name === 'await_turn') {
        state.awaitTurnSeen = true;
        resolveAttached();
        // leave it hanging — no turn is delivered; attach is all we assert
      }
    });
  });
  return { wss, port: wss.address().port, state, attached };
}

// Orchestrator stub: faithful to server.ts — POST /api/agents echoes the supplied id
// (or mints one), POST /api/agents/:id/start returns success. Records the call order.
function createOrchestratorStub() {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      calls.push({ method: req.method, path: req.url, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/api/agents') {
        const id = body.id || `agent-${Date.now()}`;
        res.end(JSON.stringify({ id, status: 'created' }));
      } else if (/^\/api\/agents\/.+\/start$/.test(req.url)) {
        res.end(JSON.stringify({ success: true }));
      } else {
        res.end(JSON.stringify({}));
      }
    });
  });
  return { server, calls };
}

describe('agent-launcher end-to-end', () => {
  const cleanups = [];
  const savedCmdJson = process.env.AGENTTALK_PERSISTENT_COMMAND_JSON;

  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) {
      try { await fn(); } catch { /* best effort */ }
    }
    if (savedCmdJson === undefined) delete process.env.AGENTTALK_PERSISTENT_COMMAND_JSON;
    else process.env.AGENTTALK_PERSISTENT_COMMAND_JSON = savedCmdJson;
  });

  it('POST /agents creates+starts in the orchestrator and spawns a real harness that attaches over WS', async () => {
    // 1. mock MCP WS server
    const mcp = await createMockMcpServer();
    cleanups.push(() => mcp.wss.close());

    // 2. orchestrator stub
    const orch = createOrchestratorStub();
    await new Promise((r) => orch.server.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise((r) => orch.server.close(r)));
    const orchestratorUrl = `http://127.0.0.1:${orch.server.address().port}`;

    // 3. fake provider bridge so the real llm-agent needs no real CLI
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'agenttalk-launcher-e2e-'));
    cleanups.push(() => rmSync(tempDir, { recursive: true, force: true }));
    const fakeBridgePath = path.join(tempDir, 'fake-bridge.js');
    writeFileSync(fakeBridgePath, [
      "const readline = require('readline');",
      "const rl = readline.createInterface({ input: process.stdin, output: process.stdout });",
      "rl.on('line', () => console.log(JSON.stringify({ type: 'result', result: 'noop', usage: { input_tokens: 0, output_tokens: 0 } })));",
    ].join('\n'), 'utf8');
    process.env.AGENTTALK_PERSISTENT_COMMAND_JSON = JSON.stringify({ command: process.execPath, args: [fakeBridgePath] });

    // 4. REAL launcher (real spawn, real fetch), harness = the real llm-agent.mjs
    const core = createLauncherCore({
      spawn,
      fetch,
      orchestratorUrl,
      llmAgentPath: path.resolve(process.cwd(), 'llm-agent.mjs'),
      mcpUrl: `ws://127.0.0.1:${mcp.port}/`,
      logger: { error: () => {} },
    });
    const launcher = createLauncherServer({ core, logger: { error: () => {} } });
    await new Promise((r) => launcher.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise((r) => launcher.close(r)));
    const launcherUrl = `http://127.0.0.1:${launcher.address().port}`;

    // safety net: kill any launched child even if an assertion throws
    cleanups.push(() => core.listAgents().forEach((a) => { try { process.kill(a.pid, 'SIGKILL'); } catch { /* gone */ } }));

    // 5. drive it: one real HTTP call launches the agent
    const res = await fetch(`${launcherUrl}/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'gemini', executionMode: 'persistent', agentId: 'e2e-1' }),
    });
    const launched = await res.json();

    // -- launch acknowledged with a real OS pid --
    expect(res.status).toBe(201);
    expect(launched).toMatchObject({ agentId: 'e2e-1', status: 'launched' });
    expect(typeof launched.pid).toBe('number');

    // -- the orchestrator really received create THEN start, for this id --
    expect(orch.calls[0]).toMatchObject({ method: 'POST', path: '/api/agents', body: { id: 'e2e-1', provider: 'gemini' } });
    expect(orch.calls[1]).toMatchObject({ method: 'POST', path: '/api/agents/e2e-1/start' });

    // -- the REAL harness attached over WS: initialize (with the wire contract) + await_turn --
    await Promise.race([
      mcp.attached,
      new Promise((_, rej) => setTimeout(() => rej(new Error('harness did not attach within 15s')), 15000)),
    ]);
    expect(mcp.state.awaitTurnSeen).toBe(true);
    expect(mcp.state.initialize?.params?.clientInfo?.contractHash).toBeTruthy();

    // -- it is tracked, and DELETE terminates it --
    expect(core.listAgents().map((a) => a.agentId)).toContain('e2e-1');
    const del = await fetch(`${launcherUrl}/agents/e2e-1`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(core.listAgents()).toEqual([]);
  }, 20000);
});
