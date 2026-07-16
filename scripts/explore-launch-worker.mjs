// Babysat-run helper: launches ONE real provider worker against an ALREADY-RUNNING orchestrator via
// the BL-037 core, then stays alive so the worker persists while a human drives the team-task path by
// hand and watches the UI.
//
// How this differs from `scripts/launcher.mjs` (the Bite 0 launcher) — they are not redundant:
// the launcher boots its OWN orchestrator and runs a whole config end-to-end, which is what you want
// for an autonomous run. This one attaches to an orchestrator that is already up, which is what you
// want when a human must have the UI open and connected BEFORE the agent is created — the ordering
// that any UI-observability check depends on (see BL-048: with the UI opened afterwards, the agent
// arrives via the normal mount fetch and the test proves nothing).
//
// Kept in the tree (PO, 2026-07-16) after it served the BL-048 live validation; still needed for the
// BL-040 D2/D4 babysat work, where `deliverGoal`/`waitForOutcome` are documented stubs.
//
// Usage: MCP_URL='ws://localhost:<dynamic-port>/' node scripts/explore-launch-worker.mjs
//   MCP_URL is REQUIRED and the port is DYNAMIC — the orchestrator announces it on stdout
//   ("MCP server URL set to: ...") AFTER "Ready to manage agents.", and it is not :3000/mcp.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLauncherCore } from '../lib/agent-launcher.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientRoot = path.resolve(__dirname, '..');

const orchestratorUrl = process.env.ORCH_URL || 'http://127.0.0.1:3000';
const mcpUrl = process.env.MCP_URL;                       // REQUIRED (dynamic port)
const provider = process.env.WORKER_PROVIDER || 'claude';
const agentId = process.env.WORKER_ID || 'bite0-worker';

if (!mcpUrl) { console.error('set MCP_URL'); process.exit(2); }

const core = createLauncherCore({
  spawn, fetch, orchestratorUrl,
  llmAgentPath: path.join(clientRoot, 'llm-agent.mjs'),
  mcpUrl, logger: console,
});

const res = await core.launchAgent({ provider, executionMode: 'persistent', agentId });
console.log('LAUNCHED', JSON.stringify(res));
console.log('[explore] worker launched; holding process alive (Ctrl-C / kill to stop).');
setInterval(() => {}, 1 << 30);
