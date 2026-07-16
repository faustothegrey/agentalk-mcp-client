#!/usr/bin/env node
// Bite 0 — the real-deps (AgentTalk) launcher entrypoint (BL-040).
//
// Assembles REAL effects around the deterministic `bite0-launcher` core and runs a config file:
//   node scripts/launcher.mjs <config.json>
//
// This entrypoint exercises the LIVE path the E2E stubbed:
//   D1  real instance-start — boots the orchestrator and parses its DYNAMIC MCP url from stdout
//   D3  real cap            — a worker with no turn parks; the wall-clock cap terminates the real process
//   D6  run artifact        — NDJSON via `config.instance.recording`
//
// DEFERRED to the PO-babysat run (documented, not faked):
//   D2/D4  real goal-delivery + outcome-detection semantics against the live orchestrator, and a real
//          authed-CLI worker turn. Here `deliverGoal` records intent and `waitForOutcome` never resolves,
//          so the worker runs until the cap — exactly the D3 hung-worker probe.

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

function assembleDeps(config, logger) {
  const recorder = config.instance?.recording
    ? createNdjsonRecorder(path.resolve(clientRoot, config.instance.recording))
    : null;

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
      });
    },

    // DEFERRED (babysat D2/D4): record intent only. No turn is delivered, so the worker parks.
    deliverGoal: async (agentId, goal) => {
      logger.error?.(`[launcher] goal-delivery DEFERRED to babysat run (D2/D4) for ${agentId}: "${String(goal).slice(0, 60)}"`);
    },

    // DEFERRED (babysat D4): outcome-detection. Never resolves → worker runs until the cap (D3 probe).
    waitForOutcome: () => new Promise(() => {}),

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
