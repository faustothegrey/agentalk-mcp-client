#!/usr/bin/env node
// Bite 0 — the real-deps (AgentTalk) launcher entrypoint (BL-040).
//
// Assembles REAL effects around the deterministic `bite0-launcher` core and runs a config file:
//   node scripts/launcher.mjs <config.json>
//
// This entrypoint exercises the LIVE path the E2E stubbed:
//   D1  real instance-start — boots the orchestrator and parses its DYNAMIC MCP url from stdout
//   D2/D4 real goal-delivery + outcome-detection — a worker-only team + a task through the product's
//         own HTTP API, then the team's own status polled to termination
//   D3  real cap            — the wall-clock cap terminates the real process
//   D6  run artifact        — NDJSON via `config.instance.recording`
//
// Known limits of D4 as built (stated, not faked):
//   - The worker's result TEXT is not reachable: tasks have no read endpoint, and completing deletes
//     team.currentTaskId. `waitForOutcome` therefore returns the terminal TEAM state; the transcript
//     lives in the NDJSON run artifact.
//   - Terminal states are 'completed' | 'error' | 'interrupted' (the TeamStatus contract). Earlier
//     notes claimed 'failed'/'awaiting_operator' — neither exists.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBite0Runner, createNdjsonRecorder } from '../lib/bite0-launcher.mjs';
import { createLauncherCore } from '../lib/agent-launcher.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientRoot = path.resolve(__dirname, '..');
const llmAgentPath = path.join(clientRoot, 'llm-agent.mjs');

// --- D1: boot the orchestrator, wait for ready, capture the DYNAMIC MCP url it announces ---
function makeStartInstance(logger) {
  return (instanceCfg = {}) => new Promise((resolve, reject) => {
    const sc = instanceCfg.startCommand;
    if (!sc?.command) {
      // No start command → assume an already-running instance addressed by the config.
      return resolve({ proc: null, orchestratorUrl: instanceCfg.orchestratorUrl, mcpUrl: instanceCfg.mcpUrl });
    }
    const cwd = sc.cwd ? path.resolve(clientRoot, sc.cwd) : process.cwd();
    const proc = spawn(sc.command, sc.args ?? [], { cwd, env: { ...process.env, ...(instanceCfg.env || {}) } });

    let mcpUrl = instanceCfg.mcpUrl ?? null;
    let sawReady = false;
    let resolved = false;
    let buf = '';
    const readyTimeoutMs = instanceCfg.readyTimeoutMs ?? 60000;
    const timer = setTimeout(() => {
      if (!resolved) { try { proc.kill('SIGKILL'); } catch { /* gone */ } reject(new Error(`instance not ready within ${readyTimeoutMs}ms`)); }
    }, readyTimeoutMs);

    // The orchestrator prints "Ready to manage agents." BEFORE it announces its (dynamic) MCP url,
    // so we must wait for BOTH signals — not resolve on the ready line alone.
    const onData = (d) => {
      buf += d.toString();
      if (/Ready to manage agents\./.test(buf)) sawReady = true;
      const m = buf.match(/MCP server URL set to:\s*(ws:\/\/\S+)/);
      if (m) mcpUrl = m[1];
      if (!resolved && sawReady && mcpUrl) {
        resolved = true;
        clearTimeout(timer);
        logger.error?.(`[launcher] instance ready — orchestrator ${instanceCfg.orchestratorUrl}, MCP ${mcpUrl}`);
        resolve({ proc, orchestratorUrl: instanceCfg.orchestratorUrl, mcpUrl });
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => {
      if (!resolved) { clearTimeout(timer); reject(new Error(`instance exited before ready (code ${code})`)); }
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every API call the launcher makes goes through here: a non-2xx from the orchestrator is a real
// failure of the run and must surface as one, not as `undefined` flowing on to a confusing error
// three steps later.
async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${url} -> ${res.status}: ${text.slice(0, 200)}`);
  try { return text ? JSON.parse(text) : null; }
  catch { throw new Error(`${url} returned non-JSON: ${text.slice(0, 200)}`); }
}

function assembleDeps(config, logger) {
  const recorder = config.instance?.recording
    ? createNdjsonRecorder(path.resolve(clientRoot, config.instance.recording))
    : null;

  // BL-064: the worker's report has no channel — it exists in the child process and crosses MCP
  // without ever being written down, so a run cannot be graded after the fact. Derived from the
  // recording so the report is filed with the run it belongs to.
  const responseLogPath = config.instance?.recording
    ? `${path.resolve(clientRoot, config.instance.recording)}.responses.ndjson`
    : null;

  // Reuse the cap's cadence for API polling — one knob, not two.
  const pollMs = config.cap?.pollIntervalMs ?? 5000;
  // Bounded because deliverGoal runs BEFORE the cap race starts (see deliverGoal).
  const agentReadyTimeoutMs = config.agents?.[0]?.readyTimeoutMs ?? 60000;

  return {
    startInstance: makeStartInstance(logger),

    // D1: real BL-037 launch against the real orchestrator + the real (dynamic) MCP url.
    launchAgent: async (agentCfg, instance) => {
      const bl037 = createLauncherCore({
        spawn, fetch,
        orchestratorUrl: instance.orchestratorUrl,
        llmAgentPath,
        mcpUrl: instance.mcpUrl,
        logger,
      });
      instance._bl037 = bl037;
      return bl037.launchAgent({
        provider: agentCfg.provider,
        model: agentCfg.model,
        executionMode: agentCfg.executionMode ?? 'persistent',
        agentId: agentCfg.id,
        workdir: agentCfg.workdir,
        // BL-064: a SIDECAR beside the run's recording, not the recording itself — the launcher and
        // the worker are separate processes, and two appenders on one file interleave on a long
        // report. No recording configured => no sidecar, and the worker logs nothing.
        responseLog: responseLogPath,
      });
    },

    // D4: deliver the goal for real — a worker-only team + a task, through the product's own API.
    deliverGoal: async (agentId, goal, instance) => {
      // The agent must be READY before it can join a team (the orchestrator rejects the create
      // outright: "Agent <id> must be ready before joining a team"). launchAgent only returns once
      // the process is spawned; 'ready' arrives later, when the worker's MCP client connects.
      //
      // This wait is BOUNDED on purpose. The cap race (step 4 of the runner) starts only AFTER
      // deliverGoal resolves, so an unbounded wait here would hang outside the anti-hang rail —
      // exactly the failure Bite 0 exists to prevent. Fail fast instead and let the run report it.
      const readyTimeoutMs = agentReadyTimeoutMs;
      const deadline = Date.now() + readyTimeoutMs;
      let status = null;
      while (Date.now() < deadline) {
        const agents = await fetchJson(`${instance.orchestratorUrl}/api/agents`);
        status = agents.find((a) => a.id === agentId)?.status ?? null;
        if (status === 'ready') break;
        if (status === 'error' || status === 'terminated') {
          throw new Error(`agent ${agentId} reached '${status}' before it could join a team`);
        }
        await sleep(pollMs);
      }
      if (status !== 'ready') {
        throw new Error(`agent ${agentId} not ready within ${readyTimeoutMs}ms (last status: ${status ?? 'unknown'})`);
      }

      const team = await fetchJson(`${instance.orchestratorUrl}/api/teams`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ members: [{ agentId, role: 'worker' }] }),
      });
      if (!team?.id) throw new Error(`team creation failed: ${JSON.stringify(team)}`);
      instance._teamId = team.id;
      logger.error?.(`[launcher] team ${team.id} created (worker-only, ${agentId})`);

      const task = await fetchJson(`${instance.orchestratorUrl}/api/teams/${team.id}/task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: goal }),
      });
      logger.error?.(`[launcher] task assigned to team ${team.id}${task?.id ? ` (task ${task.id})` : ''}`);
    },

    // D4: detect the outcome by polling the team's own status through the product API.
    // Terminal states come from the TeamStatus contract — 'completed' | 'error' | 'interrupted'.
    // (Earlier notes claimed 'failed'/'awaiting_operator'; neither exists. Verified against
    // packages/contracts/src/types.ts.) Resolving means completed; throwing is reported by the
    // runner as 'worker-error'.
    waitForOutcome: async (agentId, instance) => {
      const teamId = instance._teamId;
      if (!teamId) throw new Error('waitForOutcome: no team was created for this run');
      // No deadline here by design: the runner races this against the cap, which IS the time bound.
      for (;;) {
        const teams = await fetchJson(`${instance.orchestratorUrl}/api/teams`);
        const team = teams.find((t) => t.id === teamId);
        if (!team) throw new Error(`team ${teamId} vanished from the orchestrator`);
        if (team.status === 'completed') {
          // The worker's actual result TEXT is not reachable through the API: tasks have no read
          // endpoint, and completing deletes team.currentTaskId. What is observable is the terminal
          // team state — the run artifact (NDJSON) carries the transcript.
          return { result: { teamId, status: team.status, taskId: team.currentTaskId ?? null } };
        }
        if (team.status === 'error' || team.status === 'interrupted') {
          throw new Error(`team ${teamId} ended in '${team.status}'`);
        }
        await sleep(pollMs);
      }
    },

    terminateAgent: async (agentId, instance) => {
      try { instance._bl037?.terminateAgent(agentId); }
      catch (e) { logger.error?.(`[launcher] terminate ${agentId}: ${e?.message}`); }
    },

    // Real resource meter (:9899) — parse the capped provider's session %.
    readMeterPercent: async (meterCfg = {}) => {
      const res = await fetch(`${meterCfg.url}/usage`);
      const j = await res.json();
      const pct = j?.[meterCfg.provider]?.parsed?.current_session?.used_percent;
      return typeof pct === 'number' ? pct : 0;
    },

    setTimer: (ms, cb) => setTimeout(cb, ms),
    clearTimer: (h) => clearTimeout(h),

    stopInstance: async (instance) => {
      if (instance?.proc) {
        try { instance.proc.kill('SIGTERM'); } catch { /* gone */ }
        await new Promise((r) => setTimeout(r, 500));
        try { instance.proc.kill('SIGKILL'); } catch { /* gone */ }
      }
    },

    report: async (outcome) => { logger.error?.(`[launcher] REPORT ${JSON.stringify(outcome)}`); },

    ...(recorder ? { record: recorder } : {}),
    logger,
  };
}

async function main() {
  const configPath = process.argv[2];
  if (!configPath) {
    console.error('usage: node scripts/launcher.mjs <config.json>');
    process.exit(2);
  }
  const config = JSON.parse(readFileSync(path.resolve(configPath), 'utf8'));
  const logger = { error: (...a) => console.error(...a) };
  const runner = createBite0Runner(assembleDeps(config, logger));
  const outcome = await runner.run(config);
  console.log('\n=== BITE 0 OUTCOME ===');
  console.log(JSON.stringify(outcome, null, 2));
  process.exit(outcome.status === 'completed' ? 0 : 1);
}

main().catch((e) => { console.error('[launcher] FATAL', e); process.exit(1); });
