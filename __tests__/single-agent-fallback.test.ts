import { afterEach, describe, expect, it } from 'vitest';
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

describe('single-agent graceful fallback', () => {
  let currentServer: WebSocketServer | null = null;
  let childProcess: ChildProcessWithoutNullStreams | null = null;

  afterEach(() => {
    if (currentServer) {
      currentServer.close();
      currentServer = null;
    }
    if (childProcess) {
      childProcess.kill('SIGKILL');
      childProcess = null;
    }
  });

  it('answers a plain question via send_to_agent{to:"user"} with no planning context', async () => {
    const { wss, port, awaitConnection } = await createMockMcpServer();
    currentServer = wss;

    const agentScriptPath = path.resolve(process.cwd(), 'llm-agent.mjs');
    childProcess = spawn(
      process.execPath,
      [agentScriptPath, '--provider', 'stub', '--execution-mode', 'sandbox', '--agentId', 'test-single'],
      {
        cwd: process.cwd(),
        env: { ...process.env, AGENTTALK_PERSISTENT_MCP_URL: `ws://localhost:${port}/` },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    childProcess.stderr.on('data', d => console.log('CHILD STDERR:', d.toString()));

    const ws = await awaitConnection();

    const toolCall = await sendMcpTurn(ws, {
      type: 'message_received',
      from: 'user',
      payload: 'What is 2+2?',
    });

    expect(toolCall.params.name).toBe('send_to_agent');
    expect(toolCall.params.arguments.to).toBe('user');
    // stub returns "mock opinion" if not recognized as protocol
    expect(typeof toolCall.params.arguments.payload).toBe('string');
  });
});
