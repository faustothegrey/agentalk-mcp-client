import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createExecutor } from '../lib/executor-runtime.mjs';

// Rails for BL-045: an attached provider CLI that accepts stdin but never speaks
// the expected protocol back used to hang a turn forever. These pin the failure as
// bounded+loud.
//
// The vehicle is 'claude' because it is the only provider that still holds a
// long-lived stdio session (BasePersistentExecutor), which is the machinery these
// rails guard. It was 'gemini' until BL-057: agy is now spawned per turn, so a
// stdio session that never answers is no longer reachable on that path at all --
// gemini's turn timeout is the spawn-side one covered by the launcher suite.
//
// A command override stands in for the real CLI so the rails are tested without
// depending on a provider binary or its auth.
const persistent = (args) =>
  createExecutor({
    providerName: 'claude',
    selectedModel: null,
    requestedExecutionMode: 'auto',
    persistentCommandOverride: { command: process.execPath, args, env: process.env },
  }).executor;

// The fakes are script *files*, not `node -e` one-liners: the claude executor
// appends `--mcp-config <path> --strict-mcp-config` to the override's args, and
// node only forwards trailing args to a script. Under `-e` it would parse them as
// node options and exit before the fake ever ran.
const fixtureDir = mkdtempSync(join(tmpdir(), 'executor-hardening-'));
const fakeCli = (name, body) => {
  const scriptPath = join(fixtureDir, name);
  writeFileSync(scriptPath, body, 'utf8');
  return [scriptPath];
};

// Alive, reads stdin, never answers -- the exact agy shape.
const SILENT_BUT_ALIVE = fakeCli('silent-but-alive.js', 'process.stdin.resume(); setInterval(() => {}, 1000);');
// Dies on startup, so a later turn meets an already-dead child.
const EXITS_WITH_3 = fakeCli('exits-with-3.js', 'process.exit(3);');

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe('persistent executor hardening', () => {
  it('rejects a turn whose session is alive but never responds', async () => {
    const executor = persistent(SILENT_BUT_ALIVE);
    await executor.initialize();
    const started = Date.now();

    await expect(
      executor.executeTurn({ id: 'hc-1', prompt: 'ping' }, { timeoutMs: 300 }),
    ).rejects.toThrow(/did not respond within 300ms/);

    expect(Date.now() - started).toBeLessThan(3000);
    expect(executor.getStatus()).toBe('error');
    await executor.close();
  });

  it('reports the timeout to the sink so a caller streaming replies also learns of it', async () => {
    const executor = persistent(SILENT_BUT_ALIVE);
    await executor.initialize();
    const errors = [];

    await expect(
      executor.executeTurn({ id: 'hc-2', prompt: 'ping' }, { timeoutMs: 300, onReplyError: (e) => errors.push(e) }),
    ).rejects.toThrow(/did not respond/);

    expect(errors).toEqual([{ id: 'hc-2', error: expect.stringMatching(/did not respond within 300ms/) }]);
    await executor.close();
  });

  it('does not leave a timer armed after a turn settles', async () => {
    const executor = persistent(SILENT_BUT_ALIVE);
    await executor.initialize();
    await expect(executor.executeTurn({ id: 'hc-3', prompt: 'ping' }, { timeoutMs: 300 })).rejects.toThrow();
    expect(executor._turnTimer).toBeNull();
    await executor.close();
  });

  it('fails a turn loudly when the session died earlier, instead of waiting on a dead child', async () => {
    const executor = persistent(EXITS_WITH_3);
    await executor.initialize();
    // Let the child exit; no request is in flight, so nothing is pending to reject.
    await new Promise((r) => setTimeout(r, 250));

    await expect(executor.executeTurn({ id: 'hc-4', prompt: 'ping' }, { timeoutMs: 5000 })).rejects.toThrow(
      /session is not available: the session exited with code 3/,
    );
    expect(executor.getStatus()).toBe('error');
  });
});
