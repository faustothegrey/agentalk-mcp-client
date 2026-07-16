import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { WebSocketServer, WebSocket } from 'ws';

const wireContract = JSON.parse(readFileSync(path.resolve(process.cwd(), 'wire-contract.json'), 'utf8'));

function createMockMcpServer(): Promise<{
  wss: WebSocketServer;
  port: number;
  awaitConnection: () => Promise<WebSocket>;
  initializeRequests: any[];
  connectionUrls: string[];
}> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 });
    const initializeRequests: any[] = [];
    const connectionUrls: string[] = [];

    wss.on('listening', () => {
      const port = (wss.address() as any).port;
      
      const awaitConnection = () => new Promise<WebSocket>((resolveConn) => {
        wss.once('connection', (ws, req) => {
          connectionUrls.push(req.url || '');
          ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            // auto-reply to initialize
            if (msg.method === 'initialize') {
              initializeRequests.push(msg);
              ws.send(JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'mock', version: '1.0' } }
              }));
            }
          });
          resolveConn(ws);
        });
      });
      
      resolve({ wss, port, awaitConnection, initializeRequests, connectionUrls });
    });
  });
}

function sendMcpTurn(ws: WebSocket, eventPayload: any): Promise<any> {
  return new Promise((resolve) => {
    const onMsg = (data: any) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'tools/call' && msg.params.name === 'await_turn') {
        ws.off('message', onMsg);
        
        // Setup listener for the agent's tool call response
        const onToolCall = (data2: any) => {
          const msg2 = JSON.parse(data2.toString());
          if (msg2.method === 'tools/call' && msg2.params.name !== 'await_turn') {
            ws.off('message', onToolCall);
            // Ack the tool call
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg2.id, result: { content: [{ type: 'text', text: 'ok' }] } }));
            resolve(msg2);
          }
        };
        ws.on('message', onToolCall);
        
        // send turn
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: JSON.stringify(eventPayload) }] }
        }));
      }
    };
    ws.on('message', onMsg);
  });
}

describe('llm-agent exec-rpc via MCP', () => {
  let tempDirs: string[] = [];
  let currentServer: WebSocketServer | null = null;
  let childProcess: ChildProcessWithoutNullStreams | null = null;

  afterEach(() => {
    for (const dir of tempDirs) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
    if (currentServer) {
      currentServer.close();
      currentServer = null;
    }
    if (childProcess) {
      childProcess.kill('SIGKILL');
      childProcess = null;
    }
  });

  it('handles exec_rpc correctly and submits result', async () => {
    const { wss, port, awaitConnection, initializeRequests } = await createMockMcpServer();
    currentServer = wss;

    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'agenttalk-llm-agent-test-'));
    tempDirs.push(tempDir);
    
    // We use a fake persistent bridge that just echoes.
    // Provider is 'claude': this exercises the long-lived stdio session, which after
    // BL-057 only claude has (agy is spawned per turn -- see the nested-bridge test
    // below for gemini's path).
    const fakeBridgePath = path.join(tempDir, 'fake-persistent-bridge.js');
    writeFileSync(fakeBridgePath, [
      "const readline = require('readline');",
      "const rl = readline.createInterface({ input: process.stdin, output: process.stdout });",
      "rl.on('line', (line) => {",
      "  console.log(JSON.stringify({ type: 'result', result: 'mocked reply', usage: { input_tokens: 10, output_tokens: 20 } }));",
      "});"
    ].join('\n'), 'utf8');

    const agentScriptPath = path.resolve(process.cwd(), 'llm-agent.mjs');
    childProcess = spawn(
      process.execPath,
      [agentScriptPath, '--provider', 'claude', '--execution-mode', 'persistent', '--agentId', 'test-123'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AGENTTALK_PERSISTENT_MCP_URL: `ws://localhost:${port}/`,
          AGENTTALK_PERSISTENT_COMMAND_JSON: JSON.stringify({
            command: process.execPath,
            args: [fakeBridgePath],
          }),
        },
        stdio: 'inherit',
      },
    );

    const ws = await awaitConnection();

    const toolCall = await sendMcpTurn(ws, {
      type: 'exec_rpc',
      prompt: 'hello world',
    });

    expect(initializeRequests).toHaveLength(1);
    expect(initializeRequests[0].params.clientInfo.contractVersion).toBe(wireContract.version);
    expect(initializeRequests[0].params.clientInfo.contractHash).toBe(wireContract.hash);
    expect(toolCall.params.name).toBe('submit_exec_result');
    expect(toolCall.params.arguments).toEqual({
      text: 'mocked reply',
      usage: { prompt_tokens: 10, completion_tokens: 20 }
    });
  });

  it('appends agentId with & when the MCP URL already has a query string', async () => {
    const { wss, port, awaitConnection, connectionUrls } = await createMockMcpServer();
    currentServer = wss;

    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'agenttalk-llm-agent-url-test-'));
    tempDirs.push(tempDir);

    const fakeBridgePath = path.join(tempDir, 'fake-persistent-bridge.js');
    writeFileSync(fakeBridgePath, [
      "const readline = require('readline');",
      "const rl = readline.createInterface({ input: process.stdin, output: process.stdout });",
      "rl.on('line', () => {",
      "  console.log(JSON.stringify({ type: 'result', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } }));",
      "});"
    ].join('\n'), 'utf8');

    const agentScriptPath = path.resolve(process.cwd(), 'llm-agent.mjs');
    childProcess = spawn(
      process.execPath,
      [agentScriptPath, '--provider', 'gemini', '--execution-mode', 'persistent', '--agentId', 'test agent'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AGENTTALK_PERSISTENT_MCP_URL: `ws://localhost:${port}/?contractHash=hash-123`,
          AGENTTALK_PERSISTENT_COMMAND_JSON: JSON.stringify({
            command: process.execPath,
            args: [fakeBridgePath],
          }),
        },
        stdio: 'ignore',
      },
    );

    const ws = await awaitConnection();

    await sendMcpTurn(ws, {
      type: 'exec_rpc',
      prompt: 'hello world',
    });

    expect(connectionUrls).toEqual(['/?contractHash=hash-123&agentId=test%20agent']);
  });

  it('propagates the CLI agentId into nested persistent MCP bridge URLs', async () => {
    const { wss, port, awaitConnection } = await createMockMcpServer();
    currentServer = wss;

    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'agenttalk-llm-agent-nested-url-test-'));
    tempDirs.push(tempDir);

    const fakeAgyPath = path.join(tempDir, 'fake-agy.js');
    writeFileSync(fakeAgyPath, [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      "const path = require('path');",
      "const settingsPath = path.join(process.env.GEMINI_CLI_HOME, '.gemini', 'settings.json');",
      "const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));",
      "console.log(settings.mcpServers.bridge.args[1]);"
    ].join('\n'), 'utf8');
    chmodSync(fakeAgyPath, 0o755);

    const agentScriptPath = path.resolve(process.cwd(), 'llm-agent.mjs');
    childProcess = spawn(
      process.execPath,
      [agentScriptPath, '--provider', 'gemini', '--execution-mode', 'persistent', '--agentId', 'nested agent'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          // As the launcher does in production: the agent works in its own workdir.
          // Without it the bridge path writes its agy plugin into the repo root.
          AGENTTALK_WORKDIR: tempDir,
          AGENTTALK_PERSISTENT_MCP: 'true',
          AGENTTALK_PERSISTENT_MCP_URL: `ws://localhost:${port}/?contractHash=hash-456`,
          AGENTTALK_PERSISTENT_COMMAND_JSON: JSON.stringify({
            command: fakeAgyPath,
          }),
        },
        stdio: 'ignore',
      },
    );

    const ws = await awaitConnection();

    const toolCall = await sendMcpTurn(ws, {
      type: 'exec_rpc',
      prompt: 'inspect nested bridge url',
    });

    expect(toolCall.params.name).toBe('submit_exec_result');
    expect(toolCall.params.arguments.text.trim()).toBe(`ws://localhost:${port}/?contractHash=hash-456&agentId=nested%20agent`);
  });
});
