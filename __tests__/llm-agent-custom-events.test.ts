import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';

const PROTOCOL_PREFIX = '[AgentTalk]:';

function waitForStdoutLine(
  child: ChildProcessWithoutNullStreams,
  predicate: (line: string) => boolean,
  timeoutMs = 15_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for stdout line after ${timeoutMs}ms`));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      while (true) {
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex === -1) {
          break;
        }
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (predicate(line)) {
          cleanup();
          resolve(line);
          return;
        }
      }
    };

    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`Agent exited while waiting for line (code: ${code})`));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
    };

    child.stdout.on('data', onData);
    child.on('exit', onExit);
  });
}

function parseReq(line: string): { id: string; call: string; args?: Record<string, unknown> } {
  if (!line.startsWith(`${PROTOCOL_PREFIX}REQ:`)) {
    throw new Error(`Expected REQ line, got: ${line}`);
  }

  const payload = JSON.parse(line.slice(`${PROTOCOL_PREFIX}REQ:`.length)) as {
    id?: string;
    call?: string;
    args?: Record<string, unknown>;
  };
  if (typeof payload.id !== 'string') {
    throw new Error(`REQ payload missing id: ${line}`);
  }
  if (typeof payload.call !== 'string') {
    throw new Error(`REQ payload missing call: ${line}`);
  }

  return { id: payload.id, call: payload.call, ...(payload.args ? { args: payload.args } : {}) };
}

describe('llm-agent custom events', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  async function expectSystemInstructionToTriggerCall(callName: 'agreement_proposal' | 'agreement_acceptance') {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'agenttalk-llm-agent-test-'));
    tempDirs.push(tempDir);
    const fakeBridgePath = path.join(tempDir, 'fake-persistent-bridge.js');

    writeFileSync(fakeBridgePath, [
      "const readline = require('readline');",
      "const rl = readline.createInterface({ input: process.stdin, terminal: false });",
      "rl.on('line', () => {});",
      "setInterval(() => {}, 1000);",
    ].join('\n'), 'utf8');

    const agentScriptPath = path.resolve(process.cwd(), 'llm-agent.mjs');
    const child = spawn(
      process.execPath,
      [agentScriptPath, 'gemini', '--execution-mode', 'interactive'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AGENTTALK_PERSISTENT_COMMAND_JSON: JSON.stringify({
            command: process.execPath,
            args: [fakeBridgePath],
          }),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    try {
      await waitForStdoutLine(child, (line) => line.startsWith(`${PROTOCOL_PREFIX}READY:`));

      child.stdin.write(`${PROTOCOL_PREFIX}EVT:${JSON.stringify({
        type: 'custom_event_request',
        event: callName,
      })}\n`);

      const reqLine = await waitForStdoutLine(child, (line) => line.startsWith(`${PROTOCOL_PREFIX}REQ:`));
      expect(parseReq(reqLine).call).toBe(callName);
    } finally {
      child.kill('SIGTERM');
    }
  }

  it('emits agreement_proposal when system explicitly requests it', async () => {
    await expectSystemInstructionToTriggerCall('agreement_proposal');
  });

  it('emits agreement_acceptance when system explicitly requests it', async () => {
    await expectSystemInstructionToTriggerCall('agreement_acceptance');
  });

  it('forwards args from custom_event_request payload', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'agenttalk-llm-agent-test-'));
    tempDirs.push(tempDir);
    const fakeBridgePath = path.join(tempDir, 'fake-persistent-bridge.js');

    writeFileSync(fakeBridgePath, [
      "const readline = require('readline');",
      "const rl = readline.createInterface({ input: process.stdin, terminal: false });",
      "rl.on('line', () => {});",
      "setInterval(() => {}, 1000);",
    ].join('\n'), 'utf8');

    const agentScriptPath = path.resolve(process.cwd(), 'llm-agent.mjs');
    const child = spawn(
      process.execPath,
      [agentScriptPath, 'gemini', '--execution-mode', 'interactive'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AGENTTALK_PERSISTENT_COMMAND_JSON: JSON.stringify({
            command: process.execPath,
            args: [fakeBridgePath],
          }),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    try {
      await waitForStdoutLine(child, (line) => line.startsWith(`${PROTOCOL_PREFIX}READY:`));

      child.stdin.write(`${PROTOCOL_PREFIX}EVT:${JSON.stringify({
        type: 'custom_event_request',
        event: 'agreement_proposal',
        args: { token: 'abc-123' },
      })}\n`);

      const reqLine = await waitForStdoutLine(child, (line) => line.startsWith(`${PROTOCOL_PREFIX}REQ:`));
      expect(parseReq(reqLine)).toEqual({
        id: expect.any(String),
        call: 'agreement_proposal',
        args: { token: 'abc-123' },
      });
    } finally {
      child.kill('SIGTERM');
    }
  });

  it('uses unique request IDs for rapid consecutive custom event requests', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'agenttalk-llm-agent-test-'));
    tempDirs.push(tempDir);
    const fakeBridgePath = path.join(tempDir, 'fake-persistent-bridge.js');

    writeFileSync(fakeBridgePath, [
      "const readline = require('readline');",
      "const rl = readline.createInterface({ input: process.stdin, terminal: false });",
      "rl.on('line', () => {});",
      "setInterval(() => {}, 1000);",
    ].join('\n'), 'utf8');

    const agentScriptPath = path.resolve(process.cwd(), 'llm-agent.mjs');
    const child = spawn(
      process.execPath,
      [agentScriptPath, 'gemini', '--execution-mode', 'interactive'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AGENTTALK_PERSISTENT_COMMAND_JSON: JSON.stringify({
            command: process.execPath,
            args: [fakeBridgePath],
          }),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    try {
      await waitForStdoutLine(child, (line) => line.startsWith(`${PROTOCOL_PREFIX}READY:`));

      child.stdin.write(`${PROTOCOL_PREFIX}EVT:${JSON.stringify({
        type: 'custom_event_request',
        event: 'agreement_proposal',
      })}\n`);
      child.stdin.write(`${PROTOCOL_PREFIX}EVT:${JSON.stringify({
        type: 'custom_event_request',
        event: 'agreement_acceptance',
      })}\n`);

      const reqs: string[] = [];
      await waitForStdoutLine(child, (line) => {
        if (line.startsWith(`${PROTOCOL_PREFIX}REQ:`)) {
          reqs.push(line);
        }
        return reqs.length >= 2;
      });

      const reqA = parseReq(reqs[0]);
      const reqB = parseReq(reqs[1]);
      expect(reqA.id).not.toBe(reqB.id);
      expect([reqA.call, reqB.call].sort()).toEqual(['agreement_acceptance', 'agreement_proposal']);
    } finally {
      child.kill('SIGTERM');
    }
  }, 15_000);

  it('suppresses duplicate in-flight control calls until RES arrives', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'agenttalk-llm-agent-test-'));
    tempDirs.push(tempDir);
    const fakeBridgePath = path.join(tempDir, 'fake-persistent-bridge.js');

    writeFileSync(fakeBridgePath, [
      "const readline = require('readline');",
      "const rl = readline.createInterface({ input: process.stdin, terminal: false });",
      "rl.on('line', () => {});",
      "setInterval(() => {}, 1000);",
    ].join('\n'), 'utf8');

    const agentScriptPath = path.resolve(process.cwd(), 'llm-agent.mjs');
    const child = spawn(
      process.execPath,
      [agentScriptPath, 'gemini', '--execution-mode', 'interactive'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AGENTTALK_PERSISTENT_COMMAND_JSON: JSON.stringify({
            command: process.execPath,
            args: [fakeBridgePath],
          }),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    try {
      await waitForStdoutLine(child, (line) => line.startsWith(`${PROTOCOL_PREFIX}READY:`));

      const evt = `${PROTOCOL_PREFIX}EVT:${JSON.stringify({
        type: 'custom_event_request',
        event: 'agreement_proposal',
      })}\n`;
      child.stdin.write(evt);
      child.stdin.write(evt);

      const firstReqLine = await waitForStdoutLine(child, (line) => line.startsWith(`${PROTOCOL_PREFIX}REQ:`));
      const firstReq = parseReq(firstReqLine);
      expect(firstReq.call).toBe('agreement_proposal');

      await expect(
        waitForStdoutLine(child, (line) => line.startsWith(`${PROTOCOL_PREFIX}REQ:`), 400),
      ).rejects.toThrow('Timed out');

      child.stdin.write(`${PROTOCOL_PREFIX}RES:${JSON.stringify({
        id: firstReq.id,
        status: 'success',
      })}\n`);

      child.stdin.write(evt);
      const secondReqLine = await waitForStdoutLine(child, (line) => line.startsWith(`${PROTOCOL_PREFIX}REQ:`));
      const secondReq = parseReq(secondReqLine);
      expect(secondReq.call).toBe('agreement_proposal');
      expect(secondReq.id).not.toBe(firstReq.id);
    } finally {
      child.kill('SIGTERM');
    }
  }, 15_000);
});
