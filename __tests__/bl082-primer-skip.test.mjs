// BL-082 — a launched worker must never be halted by the turn-1 primer gate.
//
// The AgentTalk repo's `.claude/settings.json` arms a SessionStart hook that instructs a Claude
// session to perform the primer handshake, report, and STOP. For an autonomous worker that means
// doing nothing while looking healthy. The hook is already guarded by `[ -n "$AGENTTALK_SKIP_PRIMER" ]`
// — but nothing set it, so the guard had never actually been exercised.
//
// BL-080 appeared to clear this, but did not: it ran with the workdir in a *worktree*, where
// `.claude/` does not exist (it is gitignored), so the hook could not fire and the env var the
// operator exported by hand was a no-op. In the PRIMARY checkout the hook does exist.
//
// The launcher is the right place to set it: it already injects AGENTTALK_WORKDIR and
// AGENTTALK_RESPONSE_LOG into the child env for the same class of reason — "this process is a
// launched worker, not a human session".

import { describe, expect, it, vi } from 'vitest';
import { createLauncherCore } from '../lib/agent-launcher.mjs';

function makeFakeChild(pid = 1234) {
  return {
    pid,
    killed: false,
    kill: vi.fn(),
    on: vi.fn(),
  };
}

function makeFakeFetch() {
  const ok = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => json });
  return vi.fn(async (url, opts) => {
    if (url.endsWith('/api/agents')) {
      const reqId = (() => { try { return JSON.parse(opts?.body ?? '{}').id; } catch { return undefined; } })();
      return ok(200, { id: reqId ?? 'agent-resolved' });
    }
    if (url.includes('/start')) return ok(200, { success: true });
    return ok(404, { error: 'unexpected url' });
  });
}

const baseDeps = (overrides = {}) => ({
  spawn: vi.fn(() => makeFakeChild()),
  fetch: makeFakeFetch(),
  orchestratorUrl: 'http://orch:3000',
  llmAgentPath: '/abs/llm-agent.mjs',
  mcpUrl: 'ws://orch:3000/mcp',
  logger: { error: () => {} },
  isDirectory: () => true,
  ...overrides,
});

describe('BL-082 — launched agents are exempt from the turn-1 primer gate', () => {
  it('sets AGENTTALK_SKIP_PRIMER in the spawned harness env', async () => {
    const spawn = vi.fn(() => makeFakeChild());
    const core = createLauncherCore(baseDeps({ spawn }));

    await core.launchAgent({ workdir: '/w', provider: 'claude', model: 'opus', agentId: 'a1' });

    const [, , opts] = spawn.mock.calls[0];
    // The guard is a presence check (`[ -n "$AGENTTALK_SKIP_PRIMER" ]`), so any non-empty value
    // disarms it. Asserting non-empty rather than a literal keeps the bar on the contract that
    // actually matters to the hook.
    expect(opts.env.AGENTTALK_SKIP_PRIMER).toBeTruthy();
    expect(String(opts.env.AGENTTALK_SKIP_PRIMER).length).toBeGreaterThan(0);
  });

  it('applies to every provider, not just claude', async () => {
    for (const provider of ['claude', 'codex', 'gemini', 'goose']) {
      const spawn = vi.fn(() => makeFakeChild());
      const core = createLauncherCore(baseDeps({ spawn }));

      await core.launchAgent({ workdir: '/w', provider, model: 'm', agentId: `a-${provider}` });

      const [, , opts] = spawn.mock.calls[0];
      expect(opts.env.AGENTTALK_SKIP_PRIMER, `provider ${provider}`).toBeTruthy();
    }
  });

  it('does not disturb the env signals the launcher already injects', async () => {
    const spawn = vi.fn(() => makeFakeChild());
    const core = createLauncherCore(baseDeps({ spawn }));

    await core.launchAgent({ workdir: '/w', provider: 'claude', model: 'opus', agentId: 'a1' });

    const [, , opts] = spawn.mock.calls[0];
    expect(opts.env.AGENTTALK_WORKDIR).toBe('/w');
    expect(opts.env.AGENTTALK_PERSISTENT_MCP_URL).toBe('ws://orch:3000/mcp');
  });
});
