// Agent Launcher (core + HTTP server factory)
//
// Launches AgentTalk agents on demand so an operator no longer has to type a
// per-agent shell command. On request the launcher:
//   1. creates the agent record in the orchestrator  (POST /api/agents)
//   2. starts (activates) it                          (POST /api/agents/:id/start)
//   3. spawns the llm-agent harness, which PTY-drives the CLI and attaches over WS
//
// The orchestrator itself still launches nothing (M05 invariant): this service
// is a separate process that CALLS the orchestrator's existing HTTP API and does
// the local spawn on its own host, where the provider CLIs live.
//
// `spawn` and `fetch` are injected so the core is unit-testable without touching
// real processes or the network.
//
// BL-052: every launch MUST name an existing absolute `workdir`, and the worker is
// spawned with it as an explicit `cwd`. A worker with no cwd of its own inherits the
// launcher's, which is how one committed into a real checkout during the BL-040 D4 run.

import http from 'http';
import fs from 'fs';
import path from 'path';
import { resolveProvider } from './provider-runtime.mjs';

export class AgentLauncherError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.name = 'AgentLauncherError';
    this.statusCode = statusCode;
  }
}

function defaultIsDirectory(absPath) {
  try {
    return fs.statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

// BL-052. Refuse rather than inherit: a launch with no workdir lands the worker in whatever
// directory the launcher happened to occupy, and it fails silently — the worker does competent
// work in a repo nobody chose. The directory is never created here on purpose: create-if-missing
// would turn any typo into a fresh valid sandbox, which is the same fail-open in a softer form.
function validateWorkdir(workdir, isDirectory) {
  if (!workdir) {
    throw new AgentLauncherError(
      'workdir is required: refusing to launch a worker that would inherit the launcher\'s cwd (BL-052)',
      400,
    );
  }
  if (!path.isAbsolute(workdir)) {
    throw new AgentLauncherError(`workdir must be an absolute path (got ${workdir})`, 400);
  }
  if (!isDirectory(workdir)) {
    throw new AgentLauncherError(`workdir does not exist or is not a directory: ${workdir}`, 400);
  }
  return workdir;
}

/**
 * @param {object} deps
 * @param {Function} deps.spawn          child_process.spawn-compatible (returns { pid, kill, on })
 * @param {Function} deps.fetch          fetch-compatible (Response-like: { ok, status, json() })
 * @param {string}   deps.orchestratorUrl  e.g. http://localhost:3000
 * @param {string}   deps.llmAgentPath      absolute path to llm-agent.mjs
 * @param {string}   deps.mcpUrl            e.g. ws://localhost:3000/mcp
 * @param {object}  [deps.logger]        console-like
 * @param {Function} [deps.isDirectory]  (absPath) => boolean; injected so the core stays testable off-disk
 */
export function createLauncherCore({
  spawn,
  fetch,
  orchestratorUrl,
  llmAgentPath,
  mcpUrl,
  logger = console,
  isDirectory = defaultIsDirectory,
}) {
  if (typeof spawn !== 'function') throw new Error('createLauncherCore requires a spawn function');
  if (typeof fetch !== 'function') throw new Error('createLauncherCore requires a fetch function');
  if (!orchestratorUrl) throw new Error('createLauncherCore requires orchestratorUrl');
  if (!llmAgentPath) throw new Error('createLauncherCore requires llmAgentPath');

  // agentId -> { child, pid, provider, model }
  const processes = new Map();

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res;
  }

  async function launchAgent({ provider, model, executionMode, agentId, workdir, responseLog } = {}) {
    if (!provider) throw new AgentLauncherError('provider is required', 400);
    // Resolve aliases (e.g. agy -> gemini) here, at the boundary: the orchestrator
    // only understands canonical provider names and silently drops anything else,
    // so an alias must never cross the wire.
    let resolvedProvider;
    try {
      resolvedProvider = resolveProvider(String(provider).toLowerCase());
    } catch (err) {
      throw new AgentLauncherError(err.message, 400);
    }
    // BL-024 T3a: cut the orchestrator wire over to the transport/vendor axis. The three
    // enumerated vendors attach as `{transport:'attached', vendor}`; `goose` (a real vendor
    // whose axis mapping is deferred — BL-024) stays on the legacy `provider` field, which the
    // orchestrator still accepts. `agy` already resolved to `gemini` above, so the vendor case
    // covers it. This is the client half of the deprecate-then-drop migration (legacy dropped in T3b).
    const agentKind =
      resolvedProvider === 'gemini' || resolvedProvider === 'claude' || resolvedProvider === 'codex'
        ? { transport: 'attached', vendor: resolvedProvider }
        : { provider: resolvedProvider };

    // Validated here, before the orchestrator create: a refusal must not leave a half-made agent record.
    validateWorkdir(workdir, isDirectory);
    // Reject an explicit id we already run, before touching the orchestrator.
    if (agentId && processes.has(agentId)) {
      throw new AgentLauncherError(`agent ${agentId} is already launched`, 409);
    }

    // 1) create the agent record
    const createRes = await postJson(`${orchestratorUrl}/api/agents`, { id: agentId, ...agentKind, model, executionMode });
    if (!createRes.ok) {
      throw new AgentLauncherError(`orchestrator create failed (HTTP ${createRes.status})`, 502);
    }
    const created = await createRes.json();
    const resolvedId = created?.id ?? agentId;
    if (!resolvedId) throw new AgentLauncherError('orchestrator did not return an agent id', 502);
    if (processes.has(resolvedId)) {
      throw new AgentLauncherError(`agent ${resolvedId} is already launched`, 409);
    }

    // 2) start (activate) — orchestrator now waits for the WS attach
    const startRes = await postJson(`${orchestratorUrl}/api/agents/${encodeURIComponent(resolvedId)}/start`, {
      ...agentKind,
      model,
      executionMode,
    });
    if (!startRes.ok) {
      throw new AgentLauncherError(`orchestrator start failed (HTTP ${startRes.status})`, 502);
    }

    // 3) spawn the harness (it attaches over WS exactly as a manual launch would)
    const args = ['--agentId', resolvedId, '--provider', resolvedProvider];
    if (model) args.push('--model', model);
    if (executionMode) args.push('--execution-mode', executionMode);

    // AGENTTALK_WORKDIR stays alongside the explicit cwd: llm-agent.mjs chdir's on it, so the
    // worker lands in the assigned directory even if it re-execs or ignores its inherited cwd.
    // BL-064: AGENTTALK_RESPONSE_LOG travels the same way, and for the same reason — the child is
    // spawned stdio:'inherit', so its report reaches the operator's terminal but no process can
    // read it. Handing it a path is what makes the report a run artifact instead of scrollback.
    const env = { ...process.env, AGENTTALK_PERSISTENT_MCP_URL: mcpUrl, AGENTTALK_WORKDIR: workdir };
    if (responseLog) env.AGENTTALK_RESPONSE_LOG = responseLog;

    const child = spawn('node', [llmAgentPath, ...args], { env, cwd: workdir, stdio: 'inherit' });
    const record = { child, pid: child.pid, provider: resolvedProvider, model: model ?? null };
    processes.set(resolvedId, record);
    logger.error?.(`[agent-launcher] launched ${resolvedId} (pid ${child.pid}, provider ${resolvedProvider})`);

    // Reap on exit so the process table stays truthful.
    child.on?.('exit', (code, signal) => {
      logger.error?.(`[agent-launcher] agent ${resolvedId} (pid ${record.pid}) exited (code ${code}, signal ${signal})`);
      if (processes.get(resolvedId) === record) processes.delete(resolvedId);
    });

    return { agentId: resolvedId, pid: child.pid, status: 'launched' };
  }

  function listAgents() {
    return [...processes.entries()].map(([agentId, r]) => ({
      agentId,
      pid: r.pid,
      provider: r.provider,
      model: r.model,
      alive: r.child?.killed !== true,
    }));
  }

  function terminateAgent(agentId) {
    const record = processes.get(agentId);
    if (!record) throw new AgentLauncherError(`agent ${agentId} is not launched`, 404);
    record.child.kill?.('SIGTERM');
    processes.delete(agentId);
    return { agentId, terminated: true };
  }

  return { launchAgent, listAgents, terminateAgent };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) reject(new AgentLauncherError('request body too large', 413));
      else chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new AgentLauncherError('invalid JSON body', 400));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(body);
}

/**
 * Build the HTTP server around a launcher core. Routing only — all logic is in the core.
 * Routes: POST /agents · GET /agents · DELETE /agents/:id · GET /healthz
 */
export function createLauncherServer({ core, logger = console }) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const segments = url.pathname.split('/').filter(Boolean);

      if (req.method === 'GET' && url.pathname === '/healthz') {
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/agents') {
        const body = await readJsonBody(req);
        const result = await core.launchAgent(body);
        return sendJson(res, 201, result);
      }
      if (req.method === 'GET' && url.pathname === '/agents') {
        return sendJson(res, 200, { agents: core.listAgents() });
      }
      if (req.method === 'DELETE' && segments[0] === 'agents' && segments[1]) {
        const result = core.terminateAgent(decodeURIComponent(segments[1]));
        return sendJson(res, 200, result);
      }
      return sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      const status = err instanceof AgentLauncherError ? err.statusCode : 500;
      if (status >= 500) logger.error?.(`[agent-launcher] ${req.method} ${req.url} -> ${status}: ${err?.message}`);
      return sendJson(res, status, { error: err?.message ?? 'internal error' });
    }
  });
}
