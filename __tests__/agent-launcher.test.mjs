import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLauncherCore, createLauncherServer, AgentLauncherError } from '../lib/agent-launcher.mjs';

const WORKDIR = '/w';

// ---- fakes -----------------------------------------------------------------

function makeFakeChild(pid = 1234) {
  const exitHandlers = [];
  return {
    pid,
    killed: false,
    kill: vi.fn(function kill() { this.killed = true; }),
    on: vi.fn((event, cb) => { if (event === 'exit') exitHandlers.push(cb); }),
    _fireExit: (code = 0, signal = null) => exitHandlers.forEach((h) => h(code, signal)),
  };
}

function makeFakeFetch(handlers = {}) {
  // handlers: { create: () => Response-like, start: () => Response-like }
  const calls = [];
  const ok = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => json });
  const fetch = vi.fn(async (url, opts) => {
    calls.push({ url, opts });
    if (url.endsWith('/api/agents')) {
      // Faithful to the orchestrator: it echoes the supplied id, else mints one (server.ts:600).
      const reqId = (() => { try { return JSON.parse(opts?.body ?? '{}').id; } catch { return undefined; } })();
      return (handlers.create ?? (() => ok(200, { id: reqId ?? 'agent-resolved' })))();
    }
    if (url.includes('/start')) return (handlers.start ?? (() => ok(200, { success: true })))();
    return ok(404, { error: 'unexpected url' });
  });
  fetch.calls = calls;
  return fetch;
}

const baseDeps = (overrides = {}) => ({
  spawn: vi.fn(() => makeFakeChild()),
  fetch: makeFakeFetch(),
  orchestratorUrl: 'http://orch:3000',
  llmAgentPath: '/abs/llm-agent.mjs',
  mcpUrl: 'ws://orch:3000/mcp',
  logger: { error: () => {} },
  isDirectory: () => true,
  ...overrides,
});

// ---- core ------------------------------------------------------------------

describe('launcher core', () => {
  it('creates, starts, then spawns the harness with the right args and env', async () => {
    const child = makeFakeChild(4321);
    const spawn = vi.fn(() => child);
    const fetch = makeFakeFetch({ create: () => ({ ok: true, status: 200, json: async () => ({ id: 'a1' }) }) });
    const core = createLauncherCore(baseDeps({ spawn, fetch }));

    const result = await core.launchAgent({ workdir: WORKDIR, provider: 'claude', model: 'opus', executionMode: 'attach', agentId: 'a1' });

    expect(result).toEqual({ agentId: 'a1', pid: 4321, status: 'launched' });
    // orchestrator create then start, in order
    expect(fetch.calls[0].url).toBe('http://orch:3000/api/agents');
    expect(fetch.calls[1].url).toBe('http://orch:3000/api/agents/a1/start');
    // spawn: node <harness> with cli args
    const [cmd, argv, opts] = spawn.mock.calls[0];
    expect(cmd).toBe('node');
    expect(argv).toEqual(['/abs/llm-agent.mjs', '--agentId', 'a1', '--provider', 'claude', '--model', 'opus', '--execution-mode', 'attach']);
    expect(opts.env.AGENTTALK_PERSISTENT_MCP_URL).toBe('ws://orch:3000/mcp');
    expect(opts.env.AGENTTALK_WORKDIR).toBe(WORKDIR);
    // BL-052: the explicit cwd is the containment — env alone let the worker inherit the launcher's.
    expect(opts.cwd).toBe(WORKDIR);
    // tracked
    expect(core.listAgents()).toEqual([{ agentId: 'a1', pid: 4321, provider: 'claude', model: 'opus', alive: true }]);
  });

  it('BL-064: hands the worker its response-log path when the run records one', async () => {
    const spawn = vi.fn(() => makeFakeChild());
    const core = createLauncherCore(baseDeps({ spawn }));

    await core.launchAgent({
      workdir: WORKDIR, provider: 'gemini', agentId: 'a1',
      responseLog: '/runs/rung2.ndjson.responses.ndjson',
    });

    // Without this the report has nowhere to go: the child is spawned stdio:'inherit', so its
    // reasoning reaches a terminal and no run artifact.
    const [, , opts] = spawn.mock.calls[0];
    expect(opts.env.AGENTTALK_RESPONSE_LOG).toBe('/runs/rung2.ndjson.responses.ndjson');
  });

  it('BL-064: sets no response-log when the run records nothing', async () => {
    const spawn = vi.fn(() => makeFakeChild());
    const core = createLauncherCore(baseDeps({ spawn }));

    await core.launchAgent({ workdir: WORKDIR, provider: 'gemini', agentId: 'a1' });

    const [, , opts] = spawn.mock.calls[0];
    expect(opts.env.AGENTTALK_RESPONSE_LOG).toBeUndefined();
  });

  it('uses the orchestrator-resolved id when no agentId is supplied', async () => {
    const fetch = makeFakeFetch({ create: () => ({ ok: true, status: 200, json: async () => ({ id: 'server-minted' }) }) });
    const core = createLauncherCore(baseDeps({ fetch }));
    const result = await core.launchAgent({ workdir: WORKDIR, provider: 'codex' });
    expect(result.agentId).toBe('server-minted');
    expect(fetch.calls[1].url).toBe('http://orch:3000/api/agents/server-minted/start');
  });

  it('rejects a missing provider before any orchestrator call or spawn', async () => {
    const deps = baseDeps();
    const core = createLauncherCore(deps);
    await expect(core.launchAgent({})).rejects.toMatchObject({ statusCode: 400 });
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it('resolves a provider alias before the orchestrator ever sees it', async () => {
    const spawn = vi.fn(() => makeFakeChild(77));
    const fetch = makeFakeFetch({ create: () => ({ ok: true, status: 200, json: async () => ({ id: 'a1' }) }) });
    const core = createLauncherCore(baseDeps({ spawn, fetch }));

    await core.launchAgent({ workdir: WORKDIR, provider: 'agy', agentId: 'a1' });

    // The orchestrator only records canonical providers (isUsageCaptureProvider);
    // 'agy' on the wire would be silently dropped, losing usage capture.
    expect(JSON.parse(fetch.calls[0].opts.body).provider).toBe('gemini');
    expect(JSON.parse(fetch.calls[1].opts.body).provider).toBe('gemini');
    expect(spawn.mock.calls[0][1]).toContain('gemini');
    expect(spawn.mock.calls[0][1]).not.toContain('agy');
    expect(core.listAgents()[0].provider).toBe('gemini');
  });

  it('rejects an unknown provider with 400 before any orchestrator call or spawn', async () => {
    const deps = baseDeps();
    const core = createLauncherCore(deps);
    await expect(core.launchAgent({ workdir: WORKDIR, provider: 'nope' })).rejects.toMatchObject({ statusCode: 400 });
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  // BL-052: a worker spawned with no cwd inherits the launcher's. During the BL-040 D4 run that was a
  // real checkout and the worker committed into it. Each refusal below must land before the orchestrator
  // create, so a rejected launch leaves no half-made agent record behind.
  it('refuses a launch with no workdir, before any orchestrator call or spawn', async () => {
    const deps = baseDeps();
    const core = createLauncherCore(deps);
    await expect(core.launchAgent({ provider: 'claude' })).rejects.toMatchObject({ statusCode: 400 });
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it('refuses a relative workdir', async () => {
    const deps = baseDeps();
    const core = createLauncherCore(deps);
    await expect(core.launchAgent({ provider: 'claude', workdir: 'scratch/here' }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it('refuses a workdir that does not exist and never creates it', async () => {
    const deps = baseDeps({ isDirectory: vi.fn(() => false) });
    const core = createLauncherCore(deps);
    await expect(core.launchAgent({ provider: 'claude', workdir: '/nope/missing' }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(deps.isDirectory).toHaveBeenCalledWith('/nope/missing');
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it('rejects a duplicate agentId with 409 and never spawns twice', async () => {
    const deps = baseDeps({ fetch: makeFakeFetch({ create: () => ({ ok: true, status: 200, json: async () => ({ id: 'dup' }) }) }) });
    const core = createLauncherCore(deps);
    await core.launchAgent({ workdir: WORKDIR, provider: 'claude', agentId: 'dup' });
    await expect(core.launchAgent({ workdir: WORKDIR, provider: 'claude', agentId: 'dup' })).rejects.toMatchObject({ statusCode: 409 });
    expect(deps.spawn).toHaveBeenCalledTimes(1);
  });

  it('surfaces an orchestrator create failure as 502 and does not spawn', async () => {
    const deps = baseDeps({ fetch: makeFakeFetch({ create: () => ({ ok: false, status: 500, json: async () => ({}) }) }) });
    const core = createLauncherCore(deps);
    await expect(core.launchAgent({ workdir: WORKDIR, provider: 'claude' })).rejects.toMatchObject({ statusCode: 502 });
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it('surfaces an orchestrator start failure as 502 and does not spawn', async () => {
    const deps = baseDeps({ fetch: makeFakeFetch({ start: () => ({ ok: false, status: 503, json: async () => ({}) }) }) });
    const core = createLauncherCore(deps);
    await expect(core.launchAgent({ workdir: WORKDIR, provider: 'claude' })).rejects.toMatchObject({ statusCode: 502 });
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it('terminate kills the child and drops it from the table; unknown id is 404', async () => {
    const child = makeFakeChild(77);
    const core = createLauncherCore(baseDeps({ spawn: vi.fn(() => child) }));
    await core.launchAgent({ workdir: WORKDIR, provider: 'claude', agentId: 'k' });
    expect(core.terminateAgent('k')).toEqual({ agentId: 'k', terminated: true });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(core.listAgents()).toEqual([]);
    expect(() => core.terminateAgent('nope')).toThrow(AgentLauncherError);
  });

  it('reaps a child from the table when it exits', async () => {
    const child = makeFakeChild(99);
    const core = createLauncherCore(baseDeps({ spawn: vi.fn(() => child) }));
    await core.launchAgent({ workdir: WORKDIR, provider: 'claude', agentId: 'e' });
    expect(core.listAgents()).toHaveLength(1);
    child._fireExit(0, null);
    expect(core.listAgents()).toEqual([]);
  });
});

// ---- server routing (loopback, fake core) ----------------------------------

describe('launcher HTTP server', () => {
  let server;
  afterEach(() => new Promise((r) => (server ? server.close(r) : r())));

  async function listen(core) {
    server = createLauncherServer({ core, logger: { error: () => {} } });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${server.address().port}`;
  }

  const fakeCore = (over = {}) => ({
    launchAgent: vi.fn(async () => ({ agentId: 'x', pid: 1, status: 'launched' })),
    listAgents: vi.fn(() => [{ agentId: 'x', pid: 1, provider: 'claude', model: null, alive: true }]),
    terminateAgent: vi.fn(() => ({ agentId: 'x', terminated: true })),
    ...over,
  });

  it('GET /healthz -> 200 { ok: true }', async () => {
    const base = await listen(fakeCore());
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('POST /agents -> 201 and passes the body to the core', async () => {
    const core = fakeCore();
    const base = await listen(core);
    const res = await fetch(`${base}/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'claude', model: 'opus' }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ agentId: 'x', pid: 1, status: 'launched' });
    expect(core.launchAgent).toHaveBeenCalledWith({ provider: 'claude', model: 'opus' });
  });

  it('GET /agents -> 200 list', async () => {
    const base = await listen(fakeCore());
    const res = await fetch(`${base}/agents`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agents: [{ agentId: 'x', pid: 1, provider: 'claude', model: null, alive: true }] });
  });

  it('DELETE /agents/:id -> 200', async () => {
    const core = fakeCore();
    const base = await listen(core);
    const res = await fetch(`${base}/agents/x`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(core.terminateAgent).toHaveBeenCalledWith('x');
  });

  it('maps an AgentLauncherError statusCode from the core', async () => {
    const core = fakeCore({ launchAgent: vi.fn(async () => { throw new AgentLauncherError('nope', 409); }) });
    const base = await listen(core);
    const res = await fetch(`${base}/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'claude' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'nope' });
  });

  it('unknown route -> 404', async () => {
    const base = await listen(fakeCore());
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
  });
});
