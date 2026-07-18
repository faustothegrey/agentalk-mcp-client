#!/usr/bin/env node
// LLM Agent for AgentTalk V1
// Speaks the [AgentTalk]: protocol and routes messages to a selected LLM CLI.

import path from 'path';
import { provisionTaskDir } from './lib/task-worktree.mjs';
import { createRequestIdGenerator } from './lib/request-id.mjs';
import { createExecutor, normalizeRequestedExecutionMode } from './lib/executor-runtime.mjs';
import { McpClient } from './lib/mcp-client.mjs';
import { captureHostEnvironment } from './lib/environment.mjs';
import { getProviderLimit, resolveProvider } from './lib/provider-runtime.mjs';
import { createResponseRecorder } from './lib/response-log.mjs';

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

// BL-064: the run's report sink, handed down by the launcher (AGENTTALK_RESPONSE_LOG).
const recordResponse = createResponseRecorder(process.env);

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
  // BL-061: provisioning runs INSIDE the chain so that a failure to provide the task dir the
  // orchestrator asked for travels the same road as any other turn failure — reported back via
  // submit_exec_result, with `busy` released. Called outside it, a throw would escape the event
  // handler: the agent would die with `busy` stuck true and the orchestrator would learn nothing.
  // A fail-closed guard that fails as a crash is not an improvement on a silent degrade.
  Promise.resolve()
    .then(() => {
      // BL-053: `process.cwd()` is our assigned workdir — we chdir'd into it at startup.
      const taskDir = provisionTaskDir(evt.cwd, process.cwd());
      if (taskDir) console.log(`[llm-agent] task worktree: ${taskDir}`);
      return executor.executeTurn({
        id: `exec-${Date.now()}`,
        prompt: evt.prompt,
        onStderrChunk: (chunk) => process.stderr.write(chunk),
      }, {
        onReplyChunk: () => {},
        cwd: taskDir,
        timeoutMs: evt.timeoutMs,
      });
    })
    .then(async (result) => {
      try {
        // BL-064: file the report BEFORE it crosses MCP. This text is the only place the worker's
        // reasoning exists — the recording holds lifecycle only, and stdio:'inherit' puts the rest
        // in a terminal nobody can read back. Best-effort by construction: a run must never fail
        // because its observability did (recordResponse swallows its own errors).
        recordResponse({
          event: 'agent-response',
          agentId,
          text: result.response,
          usage: {
            prompt_tokens: result.tokenDetails?.input || 0,
            completion_tokens: result.tokenDetails?.output || 0,
          },
        });
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
    })
    .catch(async (err) => {
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

  // BL-071 P2 — report our own host to the orchestrator once, right after connect.
  // Fire-and-forget ON PURPOSE: the env is non-critical metadata, so it must NOT gate
  // the turn loop nor stall the agent if the peer is slow or doesn't ack it. The call
  // still goes out on the wire (ordered before the first await_turn); we just don't
  // block on its response. .catch keeps a late rejection (e.g. socket close) from
  // becoming an unhandled rejection.
  mcpClient
    .callTool('report_environment', { environment: captureHostEnvironment() })
    .then(() => console.error(`[llm-agent] Reported host environment to orchestrator.`))
    .catch((err) => console.error(`[llm-agent] Failed to report host environment (non-fatal):`, err.message));

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
