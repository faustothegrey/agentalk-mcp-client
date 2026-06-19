#!/usr/bin/env node

import { WebSocket } from 'ws';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';

const args = process.argv.slice(2);
const agentIdIndex = args.indexOf('--agentId');
const providerIndex = args.indexOf('--provider');

if (agentIdIndex === -1 || providerIndex === -1) {
  console.error("Usage: node attach-harness.mjs --agentId <id> --provider <provider>");
  process.exit(1);
}

const agentId = args[agentIdIndex + 1];
const provider = args[providerIndex + 1];
const mcpUrl = process.env.AGENTTALK_PERSISTENT_MCP_URL || `ws://localhost:3000/mcp`;
const wsUrl = `${mcpUrl}?agentId=${agentId}`;

console.log(`[Harness] Connecting to ${wsUrl} for provider ${provider}`);

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wireContractPath = path.join(__dirname, 'wire-contract.json');
const wireContract = JSON.parse(fs.readFileSync(wireContractPath, 'utf8'));

let ws = null;
let rpcId = 1;
let pendingRpc = new Map();
let reconnectDelayMs = 1000;
let isShuttingDown = false;

function connect() {
  ws = new WebSocket(wsUrl);

  ws.on('open', async () => {
    console.log(`[Harness] Connected.`);
    reconnectDelayMs = 1000; // reset delay on successful connection
    
    const initResult = await callRpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { 
        name: 'agenttalk-harness', 
        version: '1.0.0',
        contractVersion: wireContract.version,
        contractHash: wireContract.hash
      }
    });
    
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {}
    }));
    
    loop();
  });

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id !== undefined && pendingRpc.has(msg.id)) {
      const { resolve, reject } = pendingRpc.get(msg.id);
      pendingRpc.delete(msg.id);
      if (msg.error) {
        reject(new Error(msg.error.message));
      } else {
        resolve(msg.result);
      }
    }
  });

  ws.on('close', (code) => {
    console.log(`[Harness] Connection closed (code ${code}).`);
    if (isShuttingDown || code === 1011) {
      process.exit(code === 1011 ? 1 : 0);
    }
    
    // Transport drop or other closure -> Reconnect with backoff
    console.log(`[Harness] Reconnecting in ${reconnectDelayMs}ms...`);
    setTimeout(() => {
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30000); // max 30s
      connect();
    }, reconnectDelayMs);
  });

  ws.on('error', (err) => {
    console.error(`[Harness] Connection error:`, err.message);
    // error will trigger close event which handles reconnect
  });
}

function callRpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = rpcId++;
    pendingRpc.set(id, { resolve, reject });
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
}

function callTool(name, args) {
  return callRpc('tools/call', { name, arguments: args });
}

let loopActive = false;
async function loop() {
  if (loopActive) return;
  loopActive = true;
  try {
    while (!isShuttingDown && ws.readyState === WebSocket.OPEN) {
      console.log(`[Harness] Waiting for turn...`);
      const turn = await callTool('await_turn', {});
      const turnData = JSON.parse(turn.content[0].text);
      console.log(`[Harness] Received turn:`, turnData);
      
      const prompt = turnData.message;
      if (!prompt) {
        console.log(`[Harness] Empty prompt, continuing.`);
        continue;
      }
      
      console.log(`[Harness] Executing ${provider}...`);
      let output;
      try {
        output = await runProvider(provider, prompt);
      } catch (err) {
        console.error(`[Harness] CLI error:`, err);
        isShuttingDown = true;
        ws.close(1011, `CLI failure: ${err.message}`);
        return;
      }

      console.log(`[Harness] Execution complete. Sending reply...`);
      await callTool('send_to_agent', {
        to: turnData.from || 'user',
        payload: output,
        replyToMessageId: turnData.replyToMessageId
      });
    }
  } catch (err) {
    console.error(`[Harness] Loop error:`, err.message);
    // if not shutting down, just let the next reconnect spawn a new loop
  } finally {
    loopActive = false;
  }
}

process.on('SIGINT', () => {
  console.log('[Harness] Shutting down (SIGINT)...');
  isShuttingDown = true;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close(1000, 'Clean exit');
  } else {
    process.exit(0);
  }
});

process.on('SIGTERM', () => {
  console.log('[Harness] Shutting down (SIGTERM)...');
  isShuttingDown = true;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close(1000, 'Clean exit');
  } else {
    process.exit(0);
  }
});

connect();

// Model B: run the provider CLI as a plain one-shot subprocess per turn. The CLI needs no
// MCP support — the harness owns the persistent connection to AgentTalk. The model's answer
// comes on stdout (provider banners/usage go to stderr).
function runProvider(provider, prompt) {
  switch (provider) {
    case 'codex':
      return runCli('codex', ['exec', '--dangerously-bypass-approvals-and-sandbox', prompt]);
    case 'claude':
      return runCli('claude', ['-p', prompt, '--permission-mode', 'bypassPermissions']);
    case 'gemini':
      // The 'gemini' provider runs the Antigravity CLI (`agy`); the legacy `gemini` CLI is obsolete.
      return runCli('agy', ['--dangerously-skip-permissions', '-p', prompt]);
    default:
      return Promise.resolve(`Harness does not support provider ${provider}.`);
  }
}

function runCli(command, cliArgs, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, cliArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...extraEnv },
    });

    let out = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => process.stderr.write(d));

    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`${command} failed with code ${code}`));
    });
  });
}
