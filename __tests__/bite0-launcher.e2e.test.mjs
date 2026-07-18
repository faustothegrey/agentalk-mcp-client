// End-to-end for Bite 0: the REAL deterministic core orchestrates the REAL BL-037 launcher and a
// REAL spawned llm-agent harness. Proves both arcs on real sockets/processes:
//   (happy)  config -> launch -> deliver goal -> worker finishes -> COMPLETED
//   (cap)    config -> launch -> worker hangs -> real wall-clock cap terminates the real process -> FAILED
//
// Stand-ins (talked to for real over real sockets): the orchestrator (a faithful HTTP stub the BL-037
// launcher calls) and the MCP server (the turn transport). The provider CLI is a fake bridge via
// AGENTTALK_PERSISTENT_COMMAND_JSON — a real CLI turn is out of scope; Bite 0 ends when the worker
// attaches / finishes a turn.

import { afterEach, describe, expect, it } from 'vitest';
import http from 'http';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { WebSocketServer } from 'ws';
import { createBite0Runner } from '../lib/bite0-launcher.mjs';
import { createLauncherCore } from '../lib/agent-launcher.mjs';

const once = (em, ev) => new Promise((r) => em.once(ev, r));

// Mock MCP: accepts attach + initialize; holds the harness's await_turn so the test can deliver a goal
// on demand; resolves `outcome` when the harness submits any non-await_turn tool call.
async function createMockMcp() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  let pending = null;              // { ws, id } of a waiting await_turn
  let resolveOutcome;
  const outcome = new Promise((r) => (resolveOutcome = r));
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'initialize') {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'mock', version: '1.0' } } }));
      } else if (msg.method === 'tools/call' && msg.params?.name === 'await_turn') {
        pending = { ws, id: msg.id };                       // hold it; test decides whether to deliver
      } else if (msg.method === 'tools/call' && msg.params?.name === 'report_environment') {
        // BL-071 P2 — the env report is metadata, NOT a turn completion. The real
        // orchestrator just acks it (stores the host); mirror that here so it does
        // not spuriously resolve the outcome and pre-empt the wall-clock cap.
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok' }] } }));
      } else if (msg.method === 'tools/call') {             // any submit_* → the worker finished a turn
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok' }] } }));
        resolveOutcome({ tool: msg.params.name, args: msg.params.arguments });
      }
    });
  });
  return {
    wss,
    port: wss.address().port,
    outcome,
    async deliverGoal(text) {
      // wait until the harness is parked on await_turn, then answer with the goal
      const t0 = Date.now();
      while (!pending && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 20));
      if (!pending) throw new Error('harness never called await_turn');
      pending.ws.send(JSON.stringify({ jsonrpc: '2.0', id: pending.id, result: { content: [{ type: 'text', text: JSON.stringify({ type: 'exec_rpc', prompt: text }) }] } }));
      pending = null;
    },
  };
}

function createOrchestratorStub() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/api/agents') res.end(JSON.stringify({ id: body.id || 'agent-x', status: 'created' }));
      else if (/^\/api\/agents\/.+\/start$/.test(req.url)) res.end(JSON.stringify({ success: true }));
      else res.end('{}');
    });
  });
  return server;
}

// Build the real bite0 deps around the real BL-037 launcher + mock MCP + orchestrator stub.
function wireDeps({ orchestratorUrl, mcp, llmAgentPath, report, reads }) {
  const bl037 = createLauncherCore({
    spawn, fetch, orchestratorUrl, llmAgentPath,
    mcpUrl: `ws://127.0.0.1:${mcp.port}/`, logger: { error: () => {} },
  });
  return {
    startInstance: async () => ({ orchestratorUrl, mcpPort: mcp.port }),
    launchAgent: async (agentCfg) => bl037.launchAgent({
      provider: agentCfg.provider, executionMode: 'persistent', agentId: agentCfg.id, workdir: agentCfg.workdir,
    }),
    deliverGoal: async (_agentId, goal) => { if (reads.deliver) await mcp.deliverGoal(goal); },
    waitForOutcome: async () => mcp.outcome,
    terminateAgent: async (agentId) => bl037.terminateAgent(agentId),
    readMeterPercent: async () => 0,
    setTimer: (ms, cb) => setTimeout(cb, ms),
    clearTimer: (h) => clearTimeout(h),
    stopInstance: async () => {},
    report,
    logger: { error: () => {} },
    _bl037: bl037,
  };
}

describe('Bite 0 end-to-end', () => {
  const cleanups = [];
  const savedCmd = process.env.AGENTTALK_PERSISTENT_COMMAND_JSON;
  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) { try { await fn(); } catch { /* best effort */ } }
    if (savedCmd === undefined) delete process.env.AGENTTALK_PERSISTENT_COMMAND_JSON;
    else process.env.AGENTTALK_PERSISTENT_COMMAND_JSON = savedCmd;
  });

  async function setup() {
    const mcp = await createMockMcp();
    cleanups.push(() => mcp.wss.close());
    const orch = createOrchestratorStub();
    await new Promise((r) => orch.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise((r) => orch.close(r)));
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'bite0-e2e-'));
    cleanups.push(() => rmSync(tempDir, { recursive: true, force: true }));
    const fakeBridge = path.join(tempDir, 'fake-bridge.js');
    writeFileSync(fakeBridge, [
      "const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });",
      "rl.on('line', () => console.log(JSON.stringify({ type: 'result', result: 'noop', usage: { input_tokens: 0, output_tokens: 0 } })));",
    ].join('\n'), 'utf8');
    process.env.AGENTTALK_PERSISTENT_COMMAND_JSON = JSON.stringify({ command: process.execPath, args: [fakeBridge] });
    return { mcp, orchestratorUrl: `http://127.0.0.1:${orch.address().port}`, llmAgentPath: path.resolve(process.cwd(), 'llm-agent.mjs') };
  }

  it('happy path: launches a real worker, delivers the goal, worker finishes → COMPLETED', async () => {
    const { mcp, orchestratorUrl, llmAgentPath } = await setup();
    const reports = [];
    const deps = wireDeps({ orchestratorUrl, mcp, llmAgentPath, report: async (o) => reports.push(o), reads: { deliver: true } });
    cleanups.push(() => deps._bl037.listAgents().forEach((a) => { try { process.kill(a.pid, 'SIGKILL'); } catch { /* gone */ } }));

    const runner = createBite0Runner(deps);
    const outcome = await runner.run({
      instance: {},
      agents: [{ id: 'worker-1', provider: 'gemini', role: 'worker', workdir: os.tmpdir() }],
      goal: 'do the trivial task',
      cap: { wallClockMs: 15000 },
    });

    expect(outcome).toMatchObject({ agentId: 'worker-1', status: 'completed' });
    expect(reports[0]).toMatchObject({ status: 'completed' });
  }, 20000);

  it('cap breach: real worker hangs (no goal), real wall-clock terminates the real process → FAILED', async () => {
    const { mcp, orchestratorUrl, llmAgentPath } = await setup();
    const reports = [];
    // reads.deliver=false → never answer await_turn → the real harness hangs → cap must fire
    const deps = wireDeps({ orchestratorUrl, mcp, llmAgentPath, report: async (o) => reports.push(o), reads: { deliver: false } });
    let launchedPid;
    const origLaunch = deps.launchAgent;
    deps.launchAgent = async (c) => { const r = await origLaunch(c); launchedPid = r.pid; return r; };
    cleanups.push(() => deps._bl037.listAgents().forEach((a) => { try { process.kill(a.pid, 'SIGKILL'); } catch { /* gone */ } }));

    const runner = createBite0Runner(deps);
    const outcome = await runner.run({
      instance: {},
      agents: [{ id: 'worker-1', provider: 'gemini', role: 'worker', workdir: os.tmpdir() }],
      goal: 'this will not be delivered',
      cap: { wallClockMs: 1500 },   // short real timeout
    });

    expect(outcome).toMatchObject({ status: 'failed', reason: 'cap-wallclock' });
    expect(reports[0]).toMatchObject({ reason: 'cap-wallclock' });
    // the real worker process is gone (terminated by the cap)
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(launchedPid, 0)).toThrow();
  }, 20000);
});
