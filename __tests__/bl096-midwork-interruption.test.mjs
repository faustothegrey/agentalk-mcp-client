// BL-096 (re-scoped 2026-08-05) — what survives a cap kill when the worker is MID-WORK.
//
// The sibling e2e (`bite0-launcher.e2e.test.mjs:146`) already proves the wall-clock cap fires and the
// real process dies. Its worker HANGS BEFORE DOING ANYTHING, so it says nothing about interrupting work
// in flight — which is BL-096's actual original question: "whether commits survive one, whether the
// working tree is left coherent, or whether cleanup behaves."
//
// One real data point exists and it SPLIT: hmp5 was killed by cap-resource at 9m54s; the commit survived
// intact (6dcd2dd, made 14s earlier) and the worker's REPORT was destroyed, silently voiding a bar row.
// Half the artifact survived and half did not, and nobody had predicted which half.
//
// That asymmetry is the whole point here. Under the PO's chosen decoupling — unattended execution,
// grading kept human — an interrupted run's only value is the artifact a human can come back and grade.
//
// DETERMINISM: the fake bridge does real git work in a real repo up to a chosen PHASE, writes a marker,
// then BLOCKS FOREVER. The cap therefore always fires at a known point; nothing races. Every test then
// asserts the marker exists FIRST — a test that cannot prove the worker got there must fail loudly
// rather than assert on a pre-work state and report a green that means nothing.

import { afterEach, describe, expect, it } from 'vitest';
import http from 'http';
import path from 'path';
import os from 'os';
import { spawn, execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { WebSocketServer } from 'ws';
import { createBite0Runner } from '../lib/bite0-launcher.mjs';
import { createLauncherCore } from '../lib/agent-launcher.mjs';

const once = (em, ev) => new Promise((r) => em.once(ev, r));
const git = (repo, ...args) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

// The content the worker "produces". Deliberately multi-line so a truncated write is detectable
// rather than merely suspected.
const ARTIFACT = ['line-1', 'line-2', 'line-3', 'END'].join('\n');

// ---------------------------------------------------------------------------
// Transport stand-ins — same shape as bite0-launcher.e2e.test.mjs, kept local so this file does not
// couple to that one's internals. Talked to for real over real sockets.
// ---------------------------------------------------------------------------
async function createMockMcp() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  let pending = null;
  let resolveOutcome;
  let outcomeSettled = false;
  const outcome = new Promise((r) => (resolveOutcome = r));
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'initialize') {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'mock', version: '1.0' } } }));
      } else if (msg.method === 'tools/call' && msg.params?.name === 'await_turn') {
        pending = { ws, id: msg.id };
      } else if (msg.method === 'tools/call' && msg.params?.name === 'report_environment') {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok' }] } }));
      } else if (msg.method === 'tools/call') {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok' }] } }));
        outcomeSettled = true;
        resolveOutcome({ tool: msg.params.name, args: msg.params.arguments });
      }
    });
  });
  return {
    wss,
    port: wss.address().port,
    outcome,
    // Did the worker ever submit anything back through MCP? This is the "report" half of the hmp5 split.
    get workerSubmitted() { return outcomeSettled; },
    async deliverGoal(text) {
      const t0 = Date.now();
      while (!pending && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 20));
      if (!pending) throw new Error('harness never called await_turn');
      pending.ws.send(JSON.stringify({ jsonrpc: '2.0', id: pending.id, result: { content: [{ type: 'text', text: JSON.stringify({ type: 'exec_rpc', prompt: text }) }] } }));
      pending = null;
    },
  };
}

function createOrchestratorStub() {
  return http.createServer((req, res) => {
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
}

function wireDeps({ orchestratorUrl, mcp, llmAgentPath, report }) {
  const bl037 = createLauncherCore({
    spawn, fetch, orchestratorUrl, llmAgentPath,
    mcpUrl: `ws://127.0.0.1:${mcp.port}/`, logger: { error: () => {} },
  });
  return {
    startInstance: async () => ({ orchestratorUrl, mcpPort: mcp.port }),
    launchAgent: async (agentCfg) => bl037.launchAgent({
      provider: agentCfg.provider, executionMode: 'persistent', agentId: agentCfg.id, workdir: agentCfg.workdir,
    }),
    deliverGoal: async (_agentId, goal) => { await mcp.deliverGoal(goal); },
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

// The fake provider CLI. Does REAL git work in a REAL repo up to PHASE, drops a marker, then blocks.
// Paths come from env, and every git call is `git -C <repo>` — so the test's correctness does not
// depend on the spawned process's cwd. That is deliberate: forwarded-cwd semantics are exactly the
// subtlety behind BL-053/BL-059, and a harness should not rest on the thing it might be measuring.
function writeMidWorkBridge(dir) {
  const p = path.join(dir, 'midwork-bridge.cjs');
  writeFileSync(p, `
const { execFileSync } = require('child_process');
const fs = require('fs');
const repo = process.env.BL096_REPO;
const phase = process.env.BL096_PHASE;
const marker = process.env.BL096_MARKER;
const artifact = ${JSON.stringify(ARTIFACT)};
const g = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });

const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
rl.on('line', () => {
  try {
    fs.writeFileSync(repo + '/artifact.txt', artifact, 'utf8');
    if (phase === 'staged' || phase === 'committed') g('add', 'artifact.txt');
    if (phase === 'committed') {
      g('-c', 'user.name=W', '-c', 'user.email=w@example.com', 'commit', '-m', 'worker work');
    }
    fs.writeFileSync(marker, phase, 'utf8');
  } catch (e) {
    fs.writeFileSync(marker + '.error', String(e && e.message), 'utf8');
  }
  // Block forever: the cap must be what ends this process, never a natural exit.
  setInterval(() => {}, 1 << 30);
});
// Leak guard — if the cap ever fails to kill us, do not strand a process on the dev box.
setTimeout(() => process.exit(7), 25000);
`, 'utf8');
  return p;
}

describe('BL-096 — a cap kill with real work in flight', () => {
  const cleanups = [];
  const savedCmd = process.env.AGENTTALK_PERSISTENT_COMMAND_JSON;
  const savedEnv = { repo: process.env.BL096_REPO, phase: process.env.BL096_PHASE, marker: process.env.BL096_MARKER };

  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) { try { await fn(); } catch { /* best effort */ } }
    if (savedCmd === undefined) delete process.env.AGENTTALK_PERSISTENT_COMMAND_JSON;
    else process.env.AGENTTALK_PERSISTENT_COMMAND_JSON = savedCmd;
    for (const [k, v] of [['BL096_REPO', savedEnv.repo], ['BL096_PHASE', savedEnv.phase], ['BL096_MARKER', savedEnv.marker]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  // Build: a real git repo for the worker to work in, the transports, and the phase-blocking bridge.
  async function setup(phase) {
    const mcp = await createMockMcp();
    cleanups.push(() => mcp.wss.close());
    const orch = createOrchestratorStub();
    await new Promise((r) => orch.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise((r) => orch.close(r)));

    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'bl096-'));
    cleanups.push(() => rmSync(tempDir, { recursive: true, force: true }));

    // A real repo with one real base commit, so "did a commit survive" is a countable question.
    const repo = path.join(tempDir, 'workrepo');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    writeFileSync(path.join(repo, 'README.md'), 'base\n', 'utf8');
    git(repo, 'add', 'README.md');
    git(repo, '-c', 'user.name=B', '-c', 'user.email=b@example.com', 'commit', '-q', '-m', 'base');
    const baseCount = Number(git(repo, 'rev-list', '--count', 'HEAD'));
    expect(baseCount).toBe(1);

    const marker = path.join(tempDir, 'phase.marker');
    const bridge = writeMidWorkBridge(tempDir);
    process.env.BL096_REPO = repo;
    process.env.BL096_PHASE = phase;
    process.env.BL096_MARKER = marker;
    process.env.AGENTTALK_PERSISTENT_COMMAND_JSON = JSON.stringify({ command: process.execPath, args: [bridge] });

    return {
      mcp, repo, marker, tempDir,
      orchestratorUrl: `http://127.0.0.1:${orch.address().port}`,
      llmAgentPath: path.resolve(process.cwd(), 'llm-agent.mjs'),
    };
  }

  // Run to the cap and hand back everything needed to grade the wreckage.
  async function runToCap(phase) {
    const ctx = await setup(phase);
    const reports = [];
    const deps = wireDeps({ ...ctx, report: async (o) => reports.push(o) });
    cleanups.push(() => deps._bl037.listAgents().forEach((a) => { try { process.kill(a.pid, 'SIGKILL'); } catch { /* gone */ } }));

    const runner = createBite0Runner(deps);
    const outcome = await runner.run({
      instance: {},
      // provider MUST be claude: it is the only persistent executor that honours
      // AGENTTALK_PERSISTENT_COMMAND_JSON as a full command replacement (it appends
      // `--mcp-config … --strict-mcp-config`, which node passes through as script argv).
      // The gemini path ignores the override and runs the real `agy` — see the note at the
      // bottom of this file.
      agents: [{ id: 'worker-1', provider: 'claude', role: 'worker', workdir: ctx.repo }],
      goal: 'produce the artifact',
      cap: { wallClockMs: 4000 },
    });

    // GUARD, and it is the most important assertion in the file: if the worker never reached its phase,
    // everything below would be asserting on a repo nothing ever touched — a green proving nothing.
    expect(
      existsSync(ctx.marker),
      `worker never reached phase "${phase}" before the cap fired — this test proves NOTHING. ` +
      `bridge error: ${existsSync(ctx.marker + '.error') ? readFileSync(ctx.marker + '.error', 'utf8') : '(none)'}`,
    ).toBe(true);
    expect(readFileSync(ctx.marker, 'utf8')).toBe(phase);

    expect(outcome).toMatchObject({ status: 'failed', reason: 'cap-wallclock' });
    return { ...ctx, outcome, reports };
  }

  // --- coherence: the same three checks at every phase -------------------------------------------
  const assertRepoCoherent = (repo) => {
    // `git status` runs at all ⇒ the repo is readable, not corrupt.
    expect(() => git(repo, 'status', '--porcelain')).not.toThrow();
    // No abandoned index lock ⇒ a later human/agent can actually use the tree.
    expect(existsSync(path.join(repo, '.git', 'index.lock'))).toBe(false);
    // The artifact, if written at all, is COMPLETE — never a half-flushed truncation.
    const f = path.join(repo, 'artifact.txt');
    if (existsSync(f)) expect(readFileSync(f, 'utf8')).toBe(ARTIFACT);
  };

  it('phase "written": killed before staging — file complete, no commit, tree coherent', async () => {
    const { repo } = await runToCap('written');
    assertRepoCoherent(repo);
    expect(Number(git(repo, 'rev-list', '--count', 'HEAD'))).toBe(1);          // base only
    expect(git(repo, 'status', '--porcelain')).toContain('?? artifact.txt');   // untracked, as expected
  }, 30000);

  it('phase "staged": killed after `git add`, before commit — index intact, no commit, tree coherent', async () => {
    const { repo } = await runToCap('staged');
    assertRepoCoherent(repo);
    expect(Number(git(repo, 'rev-list', '--count', 'HEAD'))).toBe(1);          // still base only
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('artifact.txt'); // the index survived the kill
  }, 30000);

  it('phase "committed": killed after the commit — the commit SURVIVES intact (the hmp5 half that lived)', async () => {
    const { repo } = await runToCap('committed');
    assertRepoCoherent(repo);
    expect(Number(git(repo, 'rev-list', '--count', 'HEAD'))).toBe(2);
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('worker work');
    // committed ⇒ nothing left dirty; the tree a human returns to is clean and gradeable
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'show', 'HEAD:artifact.txt')).toBe(ARTIFACT);
  }, 30000);

  // --- the other half of the hmp5 split ----------------------------------------------------------
  it('the worker\'s own report is STRUCTURALLY LOST, while the launcher\'s report survives', async () => {
    const { mcp, reports } = await runToCap('committed');

    // The worker was killed mid-turn, so it never called submit_* — nothing it would have "said"
    // about its own work exists anywhere. This is exactly what voided an hmp5 bar row, and it is
    // NOT a bug to be fixed here: it is a property to know about before grading a killed run.
    expect(mcp.workerSubmitted).toBe(false);

    // The LAUNCHER's report does survive, and it names the cause. So a killed run is never silent —
    // but everything it tells you comes from the supervisor, never from the worker.
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ reason: 'cap-wallclock' });
  }, 30000);
});

// ---------------------------------------------------------------------------
// NOTE — observed while building this file; REPORTED, NOT FIXED (Implementer Rule 2).
//
// `bite0-launcher.e2e.test.mjs`'s header says its provider CLI is "a fake bridge via
// AGENTTALK_PERSISTENT_COMMAND_JSON". For its provider (`gemini`) that is NOT what happens:
// GeminiPersistentExecutor does not take the override as a command replacement (its own comment,
// executor-runtime.mjs:471, says agy "ignores it entirely"), so the REAL `agy` is invoked and fails
// — `agy exec failed with exit code 9`, visible in that suite's output. Its happy-path test then
// goes green because the harness reports that failure back through MCP, which resolves the outcome.
//
// So that test passes, but for a different reason than its comment claims: it proves the transport
// round-trips a turn OUTCOME, not that a fake CLI produced it. It is not wrong about the cap arc
// (the cap test never needs the bridge to do anything — it needs the worker to hang, which it does).
//
// This file therefore uses `claude`, the one persistent executor that honours the override as a
// full command replacement — verified by `exec-rpc.test.ts`, which does exactly that.
//
// Not changed here: that is someone else's scope and a behaviour question about another suite.
// ---------------------------------------------------------------------------
