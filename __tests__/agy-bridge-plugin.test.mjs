import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createExecutor, writeAgyBridgePlugin } from '../lib/executor-runtime.mjs';

// BL-045 / LB-93: `agy` (Antigravity) is a different product from the `gemini` CLI
// and does not read .gemini/settings.json. It loads MCP servers from
// `.agents/plugins/<name>/mcp_config.json` next to a `plugin.json` marker, relative
// to the workspace it is spawned in. These pin that layout -- it is agy's contract,
// not ours, so a silent drift here means the bridge stops loading with no error.
const dirs = [];
const workspace = () => {
  const d = mkdtempSync(join(tmpdir(), 'agy-plugin-test-'));
  dirs.push(d);
  return d;
};

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

const readPlugin = (ws) => {
  const dir = join(ws, '.agents', 'plugins', 'agenttalk-bridge');
  return {
    dir,
    manifest: JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')),
    mcp: JSON.parse(readFileSync(join(dir, 'mcp_config.json'), 'utf8')),
  };
};

describe('agy bridge plugin', () => {
  it('writes the plugin at the path agy discovers, with a plugin.json marker', () => {
    const ws = workspace();
    const pluginDir = writeAgyBridgePlugin(ws, 'ws://127.0.0.1:3000/mcp?agentId=a1');

    expect(pluginDir).toBe(join(ws, '.agents', 'plugins', 'agenttalk-bridge'));
    const { manifest } = readPlugin(ws);
    // plugin.json is the marker declaring the directory a plugin -- without it the
    // directory is ignored and mcp_config.json is never read.
    expect(manifest).toEqual({ name: 'agenttalk-bridge' });
  });

  it('declares the bridge as a stdio MCP server in agy mcp_config.json shape', () => {
    const ws = workspace();
    const url = 'ws://127.0.0.1:3000/mcp?agentId=a1';
    writeAgyBridgePlugin(ws, url);

    const { mcp } = readPlugin(ws);
    expect(Object.keys(mcp)).toEqual(['mcpServers']);
    expect(mcp.mcpServers.bridge.command).toBe('node');
    const [script, passedUrl] = mcp.mcpServers.bridge.args;
    expect(script).toMatch(/bridge\.mjs$/);
    expect(passedUrl).toBe(url);
  });

  it('carries the per-agent URL so two agents in one workspace do not collide', () => {
    const wsA = workspace();
    const wsB = workspace();
    writeAgyBridgePlugin(wsA, 'ws://h/mcp?agentId=a');
    writeAgyBridgePlugin(wsB, 'ws://h/mcp?agentId=b');

    expect(readPlugin(wsA).mcp.mcpServers.bridge.args[1]).toBe('ws://h/mcp?agentId=a');
    expect(readPlugin(wsB).mcp.mcpServers.bridge.args[1]).toBe('ws://h/mcp?agentId=b');
  });

  it('is idempotent and rewrites a stale URL, since it runs on every turn', () => {
    const ws = workspace();
    writeAgyBridgePlugin(ws, 'ws://h/mcp?agentId=stale');
    writeAgyBridgePlugin(ws, 'ws://h/mcp?agentId=fresh');

    expect(readPlugin(ws).mcp.mcpServers.bridge.args[1]).toBe('ws://h/mcp?agentId=fresh');
  });

  it('creates the customization root when the workspace has no .agents yet', () => {
    const ws = workspace();
    expect(existsSync(join(ws, '.agents'))).toBe(false);
    writeAgyBridgePlugin(ws, 'ws://h/mcp?agentId=a1');
    expect(existsSync(join(ws, '.agents', 'plugins', 'agenttalk-bridge', 'mcp_config.json'))).toBe(true);
  });

  // The wiring, not just the writer: initialize() -> _agentMcpUrl -> a turn writing the
  // plugin into the cwd agy is actually spawned in. A stand-in command keeps agy out of it.
  it('writes the plugin into the turn cwd, carrying the agent id from the environment', async () => {
    const ws = workspace();
    const saved = { ...process.env };
    process.env.AGENTTALK_PERSISTENT_MCP = 'true';
    process.env.AGENTTALK_PERSISTENT_MCP_URL = 'ws://127.0.0.1:9999/mcp';
    process.env.AGENTTALK_AGENT_ID = 'wired-1';
    try {
      const { executor } = createExecutor({
        providerName: 'gemini',
        selectedModel: null,
        requestedExecutionMode: 'auto',
        // Stands in for agy: rejects the agy flags, which is fine -- the plugin is
        // written before the spawn, so the turn's own outcome is irrelevant here.
        persistentCommandOverride: { command: process.execPath, env: process.env },
      });
      await executor.initialize();
      await executor.executeTurn({ id: 't1', prompt: 'hi' }, { cwd: ws, timeoutMs: 10000 }).catch(() => {});

      const { mcp } = readPlugin(ws);
      expect(mcp.mcpServers.bridge.args[1]).toBe('ws://127.0.0.1:9999/mcp?agentId=wired-1');
      await executor.close();
    } finally {
      process.env = saved;
    }
  });
});
