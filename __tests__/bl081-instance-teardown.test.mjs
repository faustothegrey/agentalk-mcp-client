// BL-081 — the launcher must tear down the WHOLE instance process tree, not just the wrapper.
//
// The defect, observed live during the BL-080 spike: `instance.startCommand` is typically
// `npm run backend`, so the process the launcher spawns is *npm* — and npm's real child
// (`node dist/index.js`) survives a kill aimed at npm, is reparented to init (PPID 1), and keeps
// holding the port. After a clean exit-0 run, port 3400 was still LISTENing on pid 69131.
//
// This test asserts against a REAL process tree rather than a mocked `kill` call: a wrapper shell
// launches a genuine grandchild that records its own pid, and the bar is whether that pid is still
// alive after `stopInstance`. A mock would only prove we called kill on the object we already had —
// which is exactly the thing that was never in doubt.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assembleDeps } from '../scripts/launcher.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

async function waitFor(predicate, timeoutMs = 5000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return false;
}

let leaked = [];
afterEach(() => {
  // Never let a failing run leave a live process behind — this suite exists because of leaks.
  for (const pid of leaked) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  leaked = [];
});

describe('BL-081 — instance teardown', () => {
  it('stopInstance kills the grandchild, not only the spawned wrapper', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bl081-'));
    const pidFile = path.join(dir, 'grandchild.pid');

    // Mirrors `npm run backend`: a wrapper that launches the real server as a child, announces the
    // two lines the launcher waits for, then stays alive. The grandchild records its own pid.
    const inner =
      'require("fs").writeFileSync(process.env.PIDFILE, String(process.pid));' +
      'setInterval(() => {}, 1e9);';
    const wrapper =
      `node -e '${inner}' & ` +
      'echo "Ready to manage agents."; ' +
      'echo "[Server] AgentTalk MCP server URL set to: ws://localhost:1/"; ' +
      'wait';

    const config = {
      instance: {
        orchestratorUrl: 'http://127.0.0.1:1',
        env: { PIDFILE: pidFile },
        startCommand: { command: 'sh', args: ['-c', wrapper] },
      },
    };

    const deps = assembleDeps(config, { error: () => {} });
    const instance = await deps.startInstance(config.instance);
    expect(instance.proc).toBeTruthy();
    leaked.push(instance.proc.pid);

    expect(await waitFor(() => existsSync(pidFile))).toBe(true);
    const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
    expect(Number.isInteger(grandchild)).toBe(true);
    leaked.push(grandchild);

    // Precondition: the tree really is two processes deep and both are up.
    expect(alive(grandchild)).toBe(true);

    await deps.stopInstance(instance);

    // THE BAR: the grandchild must be gone. Before the fix it survives, reparented to init.
    const died = await waitFor(() => !alive(grandchild), 3000);
    expect(died, `grandchild pid ${grandchild} survived stopInstance (orphaned)`).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  }, 20000);
});
