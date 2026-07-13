#!/usr/bin/env node
// LLM Agent for AgentTalk V1
// Speaks the [AgentTalk]: protocol and routes messages to a selected LLM CLI.

import path from 'path';
import { createRequestIdGenerator } from './lib/request-id.mjs';
import { createExecutor, normalizeRequestedExecutionMode } from './lib/executor-runtime.mjs';
import { McpClient } from './lib/mcp-client.mjs';
import { getProviderLimit, resolveProvider } from './lib/provider-runtime.mjs';

function parseArgs(argv) {
  const providerIndex = argv.indexOf('--provider');
  const provider = providerIndex !== -1 && argv[providerIndex + 1] ? argv[providerIndex + 1] : 'gemini';
  const modelIndex = argv.indexOf('--model');
  const model = modelIndex !== -1 && argv[modelIndex + 1] ? argv[modelIndex + 1] : null;
  const executionModeIndex = argv.indexOf('--execution-mode');
  const executionMode = executionModeIndex !== -1 && argv[executionModeIndex + 1]
    ? argv[executionModeIndex + 1]
    : process.env.AGENTTALK_EXECUTION_MODE;
  const agentIdIndex = argv.indexOf('--agentId');
  const agentId = agentIdIndex !== -1 && argv[agentIdIndex + 1] ? argv[agentIdIndex + 1] : null;

  return { provider, model, executionMode, agentId };
}

function parsePersistentCommandOverrideFromEnv() {
  // Deprecated alias AGENTTALK_INTERACTIVE_COMMAND_JSON still accepted for backward compatibility.
  const raw = process.env.AGENTTALK_PERSISTENT_COMMAND_JSON ?? process.env.AGENTTALK_INTERACTIVE_COMMAND_JSON;
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return undefined;
    }

    const command = typeof parsed.command === 'string' ? parsed.command : undefined;
    const args = Array.isArray(parsed.args) ? parsed.args.filter((value) => typeof value === 'string') : [];
    const env = parsed.env && typeof parsed.env === 'object'
      ? { ...process.env, ...parsed.env }
      : process.env;

    if (!command) {
      return undefined;
    }

    return { command, args, env };
  } catch (err) {
    console.error(`[llm-agent] Ignoring invalid AGENTTALK_PERSISTENT_COMMAND_JSON: ${err.message}`);
    return undefined;
  }
}

const {
  provider: providerName,
  model: selectedModel,
  executionMode: requestedExecutionModeInput,
  agentId,
} = parseArgs(process.argv);

if (agentId) {
  process.env.AGENTTALK_AGENT_ID = agentId;
}

const provider = resolveProvider(providerName.toLowerCase());
const limit = getProviderLimit(provider, selectedModel);
const requestedWorkingDirectory = process.env.AGENTTALK_WORKDIR;
const requestedExecutionMode = normalizeRequestedExecutionMode(requestedExecutionModeInput);
const persistentCommandOverride = parsePersistentCommandOverrideFromEnv();

function appendAgentId(url, id) {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}agentId=${encodeURIComponent(id)}`;
}

if (requestedWorkingDirectory) {
  const resolvedWorkingDirectory = path.resolve(requestedWorkingDirectory);
  process.chdir(resolvedWorkingDirectory);
  console.error(`[llm-agent] Working directory set to ${resolvedWorkingDirectory}`);
}

let busy = false;
let mcpClient;
let isShuttingDown = false;
const nextRequestId = createRequestIdGenerator();
const {
  requestedExecutionMode: normalizedRequestedExecutionMode,
  resolvedExecutionMode,
  executor,
} = createExecutor({
  providerName: provider,
  selectedModel,
  requestedExecutionMode,
  ...(persistentCommandOverride ? { persistentCommandOverride } : {}),
});

function handleExecRpc(evt) {
  busy = true;
  executor.executeTurn({
    id: `exec-${Date.now()}`,
    prompt: evt.prompt,
    onStderrChunk: (chunk) => process.stderr.write(chunk),
  }, {
    onReplyChunk: () => {},
    cwd: evt.cwd,
    timeoutMs: evt.timeoutMs,
  }).then(async (result) => {
    try {
      await mcpClient.callTool('submit_exec_result', {
        text: result.response,
        usage: {
          prompt_tokens: result.tokenDetails?.input || 0,
          completion_tokens: result.tokenDetails?.output || 0
        }
      });
    } catch (err) {
      console.error(`[llm-agent] Failed to submit exec result:`, err);
    } finally {
      busy = false;
    }
  }).catch(async (err) => {
    console.error(`[llm-agent] exec_rpc failed:`, err);
    try {
      await mcpClient.callTool('submit_exec_result', {
        text: `ERROR: ${err.message}`,
      });
    } catch (submitErr) {
      console.error(`[llm-agent] Failed to submit exec error:`, submitErr);
    } finally {
      busy = false;
    }
  });
}

function handleHealthcheck(evt) {
  busy = true;
  executor.executeTurn({
    id: `health-${Date.now()}`,
    prompt: evt.prompt,
    onStderrChunk: (chunk) => process.stderr.write(chunk),
  }, {
    onReplyChunk: () => {},
    timeoutMs: evt.timeoutMs,
  }).then(async (result) => {
    try {
      await mcpClient.callTool('healthcheck_ack', {
        token: evt.token,
        message: result.response
      });
    } catch (err) {
      console.error(`[llm-agent] Failed to submit healthcheck_ack:`, err);
    } finally {
      busy = false;
    }
  }).catch(async (err) => {
    console.error(`[llm-agent] healthcheck failed:`, err);
    try {
      await mcpClient.callTool('healthcheck_ack', {
        token: evt.token,
        message: `ERROR: ${err.message}`,
      });
    } catch (submitErr) {
      console.error(`[llm-agent] Failed to submit error healthcheck_ack:`, submitErr);
    } finally {
      busy = false;
    }
  });
}

function handleInboundEvent(evt) {
  if (evt.type === 'exec_rpc') {
    handleExecRpc(evt);
    return;
  }

  if (evt.type === 'healthcheck') {
    handleHealthcheck(evt);
    return;
  }

  if (evt.type === 'conversation_end') {
    console.error(`[llm-agent] Conversation ended: ${evt.reason}`);

    // After conversation ends, request agent to shutdown after a small delay to finish any pending work.
    console.error('[llm-agent] Requesting shutdown in 5s...');
    setTimeout(() => {
      console.error('[llm-agent] Graceful shutdown initiated.');
      process.exit(0);
    }, 5000);
    return;
  }
}

async function main() {
  if (!agentId) {
    console.error("Usage: node llm-agent.mjs --agentId <id> --provider <provider> ...");
    process.exit(1);
  }

  await executor.initialize();

  console.error(
    `[llm-agent] Provider: ${provider}, Model: ${selectedModel || 'default'}, Token Limit: ${limit}, Execution Mode: ${normalizedRequestedExecutionMode} -> ${resolvedExecutionMode}`,
  );

  const mcpUrl = process.env.AGENTTALK_PERSISTENT_MCP_URL || `ws://localhost:3000/mcp`;
  mcpClient = new McpClient(appendAgentId(mcpUrl, agentId));
  await mcpClient.connect();

  let loopActive = false;
  async function loop() {
    if (loopActive) return;
    loopActive = true;
    try {
      while (!isShuttingDown && mcpClient.ws.readyState === 1 /* OPEN */) {
        console.error(`[llm-agent] Waiting for turn...`);
        const turn = await mcpClient.callTool('await_turn', {});
        const evt = JSON.parse(turn.content[0].text);
        console.error(`[llm-agent] Received turn:`, evt);

        handleInboundEvent(evt);

        // Wait for handling to finish before pulling next turn
        while (busy) {
          await new Promise(r => setTimeout(r, 50));
        }
      }
    } catch (err) {
      console.error(`[llm-agent] Turn loop error:`, err);
      isShuttingDown = true;
      mcpClient.close(1011, `CLI failure: ${err.message}`);
    } finally {
      loopActive = false;
    }
  }

  loop();
}

main().catch((err) => {
  console.error(`[llm-agent] Fatal error: ${err.message}`);
  process.exit(1);
});
