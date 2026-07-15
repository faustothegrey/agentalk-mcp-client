#!/usr/bin/env node
// agent-launcher — HTTP service that launches AgentTalk agents on demand.
//
// Replaces the manual `node llm-agent.mjs --agentId … --provider …` shell step:
// POST /agents { provider, model?, executionMode?, agentId?, workdir? } creates
// and starts the agent in the orchestrator and spawns the harness locally.
//
// SECURITY: this endpoint spawns local processes. It binds 127.0.0.1 ONLY and
// must NOT be exposed on an external interface without an auth layer.
//
// Env:
//   AGENT_LAUNCHER_PORT           listen port           (default 4100)
//   AGENTTALK_ORCHESTRATOR_URL    orchestrator HTTP base (default http://localhost:3000)
//   AGENTTALK_PERSISTENT_MCP_URL  MCP WS url passed to the harness (default ws://localhost:3000/mcp)

import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { createLauncherCore, createLauncherServer } from './lib/agent-launcher.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.AGENT_LAUNCHER_PORT || 4100);
const HOST = '127.0.0.1';
const orchestratorUrl = process.env.AGENTTALK_ORCHESTRATOR_URL || 'http://localhost:3000';
const mcpUrl = process.env.AGENTTALK_PERSISTENT_MCP_URL || 'ws://localhost:3000/mcp';
const llmAgentPath = path.join(__dirname, 'llm-agent.mjs');

const core = createLauncherCore({ spawn, fetch, orchestratorUrl, llmAgentPath, mcpUrl });
const server = createLauncherServer({ core });

server.listen(PORT, HOST, () => {
  console.error(`[agent-launcher] listening on http://${HOST}:${PORT}`);
  console.error(`[agent-launcher] orchestrator=${orchestratorUrl} mcp=${mcpUrl}`);
  console.error(`[agent-launcher] harness=${llmAgentPath}`);
});
