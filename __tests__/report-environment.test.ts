import { afterEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'fs';
import path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { captureHostEnvironment } from '../lib/environment.mjs';

describe('captureHostEnvironment (BL-071 P2, client)', () => {
  it('returns the full HostEnvironment shape matching a fresh os read', () => {
    const env = captureHostEnvironment();
    expect(env.platform).toBe(os.platform());
    expect(env.arch).toBe(os.arch());
    expect(env.osRelease).toBe(os.release());
    expect(env.nodeVersion).toBe(process.version);
    expect(env.hostname).toBe(os.hostname());
    expect(env.cpuCount).toBeGreaterThan(0);
    expect(env.totalMemBytes).toBeGreaterThan(0);
    expect(Object.keys(env).sort()).toEqual(
      ['arch', 'capturedAt', 'cpuCount', 'hostname', 'nodeVersion', 'osRelease', 'platform', 'totalMemBytes'].sort(),
    );
  });

  it('stamps capturedAt from the injected clock', () => {
    const fixed = Date.parse('2026-07-18T10:30:00.000Z');
    expect(captureHostEnvironment({ now: () => fixed }).capturedAt).toBe('2026-07-18T10:30:00.000Z');
  });
});

function createMockMcpServer(): Promise<{ wss: WebSocketServer; port: number; awaitConnection: () => Promise<WebSocket> }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 });
    wss.on('listening', () => {
      const port = (wss.address() as any).port;
      const awaitConnection = () => new Promise<WebSocket>((resolveConn) => {
        wss.once('connection', (ws) => {
          ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.method === 'initialize') {
              ws.send(JSON.stringify({
                jsonrpc: '2.0', id: msg.id,
                result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'mock', version: '1.0' } },
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

// The report_environment call fires right after connect, before the await_turn loop.
function awaitReportEnvironment(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    const onMsg = (data: any) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'tools/call' && msg.params.name === 'report_environment') {
        ws.off('message', onMsg);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok' }] } }));
        resolve(msg);
      }
    };
    ws.on('message', onMsg);
  });
}

describe('llm-agent reports its host environment on connect (BL-071 P2)', () => {
  let tempDirs: string[] = [];
  let currentServer: WebSocketServer | null = null;
  let childProcess: ChildProcessWithoutNullStreams | null = null;

  afterEach(() => {
    for (const dir of tempDirs) if (dir) rmSync(dir, { recursive: true, force: true });
    tempDirs = [];
    if (currentServer) { currentServer.close(); currentServer = null; }
    if (childProcess) { childProcess.kill('SIGKILL'); childProcess = null; }
  });

  it('calls report_environment with its own host right after connecting', async () => {
    const { wss, port, awaitConnection } = await createMockMcpServer();
    currentServer = wss;

    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'agenttalk-report-env-test-'));
    tempDirs.push(tempDir);
    // A trivial fake provider CLI so the persistent executor initializes cleanly.
    const fakeAgyPath = path.join(tempDir, 'fake-agy.js');
    writeFileSync(fakeAgyPath, '#!/usr/bin/env node\nprocess.stdin.resume();\n', 'utf8');
    chmodSync(fakeAgyPath, 0o755);

    const agentScriptPath = path.resolve(process.cwd(), 'llm-agent.mjs');
    childProcess = spawn(
      process.execPath,
      [agentScriptPath, '--provider', 'gemini', '--execution-mode', 'persistent', '--agentId', 'env-reporter'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AGENTTALK_WORKDIR: tempDir,
          AGENTTALK_PERSISTENT_MCP_URL: `ws://localhost:${port}/?contractHash=hash-xyz`,
          AGENTTALK_PERSISTENT_COMMAND_JSON: JSON.stringify({ command: fakeAgyPath }),
        },
        stdio: 'ignore',
      },
    );

    const ws = await awaitConnection();
    const toolCall = await awaitReportEnvironment(ws);

    expect(toolCall.params.name).toBe('report_environment');
    const env = toolCall.params.arguments.environment;
    // The child runs on this same machine, so its self-observed host must match ours.
    expect(env.platform).toBe(os.platform());
    expect(env.arch).toBe(os.arch());
    expect(env.hostname).toBe(os.hostname());
    expect(env.nodeVersion).toBe(process.version);
    expect(env.cpuCount).toBeGreaterThan(0);
    expect(env.totalMemBytes).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(env.capturedAt))).toBe(false);
  }, 15000);
});
