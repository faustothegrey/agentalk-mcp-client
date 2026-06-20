import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { WebSocketServer, WebSocket } from 'ws';

function createMockMcpServer(): Promise<{ wss: WebSocketServer; port: number; awaitConnection: () => Promise<WebSocket> }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 });
    wss.on('listening', () => {
      const port = (wss.address() as any).port;
      
      const awaitConnection = () => new Promise<WebSocket>((resolveConn) => {
        wss.once('connection', (ws) => {
          ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            // auto-reply to initialize
            if (msg.method === 'initialize') {
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
      
      resolve({ wss, port, awaitConnection });
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

describe('llm-agent custom events via MCP', () => {
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

  async function expectSystemInstructionToTriggerCall(callName: 'agreement_proposal' | 'agreement_acceptance') {
    const { wss, port, awaitConnection } = await createMockMcpServer();
    currentServer = wss;

    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'agenttalk-llm-agent-test-'));
    tempDirs.push(tempDir);
    const fakeBridgePath = path.join(tempDir, 'fake-persistent-bridge.js');

    writeFileSync(fakeBridgePath, [
      "setInterval(() => {}, 1000);",
    ].join('\n'), 'utf8');

    const agentScriptPath = path.resolve(process.cwd(), 'llm-agent.mjs');
    childProcess = spawn(
      process.execPath,
      [agentScriptPath, 'gemini', '--execution-mode', 'interactive', '--agentId', 'test-123'],
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
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    const ws = await awaitConnection();

    const toolCall = await sendMcpTurn(ws, {
      type: 'custom_event_request',
      event: callName,
    });

    expect(toolCall.params.name).toBe(callName);
  }

  it('emits agreement_proposal when system explicitly requests it', async () => {
    await expectSystemInstructionToTriggerCall('agreement_proposal');
  });

  it('emits agreement_acceptance when system explicitly requests it', async () => {
    await expectSystemInstructionToTriggerCall('agreement_acceptance');
  });

  it('forwards args from custom_event_request payload', async () => {
    const { wss, port, awaitConnection } = await createMockMcpServer();
    currentServer = wss;

    const agentScriptPath = path.resolve(process.cwd(), 'llm-agent.mjs');
    childProcess = spawn(
      process.execPath,
      [agentScriptPath, 'gemini', '--execution-mode', 'sandbox', '--agentId', 'test-123'],
      {
        cwd: process.cwd(),
        env: { ...process.env, AGENTTALK_PERSISTENT_MCP_URL: `ws://localhost:${port}/` },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    const ws = await awaitConnection();

    const toolCall = await sendMcpTurn(ws, {
      type: 'custom_event_request',
      event: 'request_human_intervention',
      args: { reason: 'I need human help' },
    });

    expect(toolCall.params.name).toBe('request_human_intervention');
    expect(toolCall.params.arguments).toEqual({ reason: 'I need human help' });
  });
});
