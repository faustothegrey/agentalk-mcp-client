import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createExecutor, writeAgyMcpConfig } from '../lib/executor-runtime.mjs';

// BL-045 / LB-93: agy only spawns MCP servers declared in its HOME-level
// `~/.gemini/config/mcp_config.json`. Project-local mcp_config is discovered and then
// silently ignored (antigravity-cli#60) -- the failure mode is "valid config, no
// servers, no error", so these pin the path and the HOME redirect that make it load.
const dirs = [];
const home = () => {
  const d = mkdtempSync(join(tmpdir(), 'agy-home-test-'));
  dirs.push(d);
  return d;
};

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

const readConfig = (h, variant = 'config') =>
  JSON.parse(readFileSync(join(h, '.gemini', variant, 'mcp_config.json'), 'utf8'));

describe('agy HOME-level mcp_config', () => {
  it('writes the bridge to the path agy actually loads MCP servers from', () => {
    const h = home();
    const written = writeAgyMcpConfig(h, 'ws://127.0.0.1:3000/mcp?agentId=a1');

    expect(written).toContain(join(h, '.gemini', 'config', 'mcp_config.json'));
    const cfg = readConfig(h);
    expect(Object.keys(cfg)).toEqual(['mcpServers']);
    expect(cfg.mcpServers.bridge.command).toBe('node');
    const [script, url] = cfg.mcpServers.bridge.args;
    expect(script).toMatch(/bridge\.mjs$/);
    expect(url).toBe('ws://127.0.0.1:3000/mcp?agentId=a1');
  });

  it('also writes the pre-migration path, so loading does not hinge on agy version', () => {
    const h = home();
    writeAgyMcpConfig(h, 'ws://h/mcp?agentId=a1');
    expect(readConfig(h, 'antigravity-cli')).toEqual(readConfig(h, 'config'));
  });

  it('does not write a project-local config, which agy reads and then ignores', () => {
    const h = home();
    writeAgyMcpConfig(h, 'ws://h/mcp?agentId=a1');
    // Guards the regression that cost us the plugin round: a config here looks valid
    // (agy plugin validate passes) but never spawns a server.
    expect(existsSync(join(h, '.agents'))).toBe(false);
  });

  // The isolation guarantee: HOME-level config is global by nature, so two agents must
  // get separate homes or they collide on one bridge URL -- which would silently wire
  // every agent to the same orchestrator session.
  it('keeps per-agent bridge URLs isolated across separate homes', () => {
    const a = home();
    const b = home();
    writeAgyMcpConfig(a, 'ws://h/mcp?agentId=a');
    writeAgyMcpConfig(b, 'ws://h/mcp?agentId=b');

    expect(readConfig(a).mcpServers.bridge.args[1]).toBe('ws://h/mcp?agentId=a');
    expect(readConfig(b).mcpServers.bridge.args[1]).toBe('ws://h/mcp?agentId=b');
  });

  it('points the executor HOME at the agent temp home and writes the config there', async () => {
    const saved = { ...process.env };
    process.env.AGENTTALK_PERSISTENT_MCP_URL = 'ws://127.0.0.1:9999/mcp';
    process.env.AGENTTALK_AGENT_ID = 'wired-1';
    try {
      const { executor } = createExecutor({
        providerName: 'gemini',
        selectedModel: null,
        requestedExecutionMode: 'auto',
        persistentCommandOverride: { command: process.execPath, env: process.env },
      });
      await executor.initialize();

      const agentHome = executor._mcpHomeDir;
      expect(agentHome).toBeTruthy();
      // Written at initialize, into this agent's own home, carrying its own id.
      expect(readConfig(agentHome).mcpServers.bridge.args[1]).toBe('ws://127.0.0.1:9999/mcp?agentId=wired-1');
      // A temp home is useless unless HOME actually points there when agy runs.
      expect(process.env.HOME).not.toBe(agentHome);
      await executor.close();
    } finally {
      process.env = saved;
    }
  });
});
