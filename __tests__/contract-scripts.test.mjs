import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const verifyScript = path.join(repoRoot, 'scripts/verify-contract.js');
const syncScript = path.join(repoRoot, 'scripts/sync-wire-contract.js');

function contractFor(version, mcpTools) {
  const data = {
    mcpTools,
    packetTypes: ['READY', 'REQ', 'RES', 'EVT'],
    protocolPrefix: '[AgentTalk]:',
  };
  const hash = crypto.createHash('sha256').update(JSON.stringify(data, null, 2)).digest('hex');
  return { version, hash, data };
}

function runNode(scriptPath, env) {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

describe('wire contract scripts', () => {
  it('verifies matching source and client contracts', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'agenttalk-contract-'));
    try {
      const sourcePath = path.join(tempDir, 'source.json');
      const clientPath = path.join(tempDir, 'client.json');
      const contract = contractFor(7, ['await_turn', 'submit_exec_result']);
      const contents = JSON.stringify(contract, null, 2) + '\n';
      writeFileSync(sourcePath, contents, 'utf8');
      writeFileSync(clientPath, contents, 'utf8');

      const result = runNode(verifyScript, {
        AGENTTALK_CONTRACT_PATH: sourcePath,
        AGENTTALK_CLIENT_CONTRACT_PATH: clientPath,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Contract alignment verified successfully');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('fails when the client contract diverges from the AgentTalk source', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'agenttalk-contract-'));
    try {
      const sourcePath = path.join(tempDir, 'source.json');
      const clientPath = path.join(tempDir, 'client.json');
      const sourceContract = contractFor(7, ['await_turn', 'submit_exec_result']);
      const staleClientContract = contractFor(5, ['await_turn', 'submit_plan']);
      writeFileSync(sourcePath, JSON.stringify(sourceContract, null, 2) + '\n', 'utf8');
      writeFileSync(clientPath, JSON.stringify(staleClientContract, null, 2) + '\n', 'utf8');

      const result = runNode(verifyScript, {
        AGENTTALK_CONTRACT_PATH: sourcePath,
        AGENTTALK_CLIENT_CONTRACT_PATH: clientPath,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('wire contracts diverged');
      expect(result.stderr).toContain('AgentTalk: v7');
      expect(result.stderr).toContain('Client:    v5');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('syncs the client contract from the AgentTalk source', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'agenttalk-contract-'));
    try {
      const sourcePath = path.join(tempDir, 'source.json');
      const clientPath = path.join(tempDir, 'client.json');
      const sourceContract = contractFor(7, ['await_turn', 'submit_exec_result']);
      const staleClientContract = contractFor(5, ['await_turn', 'submit_plan']);
      writeFileSync(sourcePath, JSON.stringify(sourceContract, null, 2) + '\n', 'utf8');
      writeFileSync(clientPath, JSON.stringify(staleClientContract, null, 2) + '\n', 'utf8');

      const result = runNode(syncScript, {
        AGENTTALK_CONTRACT_PATH: sourcePath,
        AGENTTALK_CLIENT_CONTRACT_PATH: clientPath,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Synced wire-contract.json from AgentTalk v7');
      expect(readFileSync(clientPath, 'utf8')).toBe(JSON.stringify(sourceContract, null, 2) + '\n');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
