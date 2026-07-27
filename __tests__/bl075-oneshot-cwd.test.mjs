import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { callProvider } from '../lib/provider-runtime.mjs';
import { createExecutor } from '../lib/executor-runtime.mjs';

// BL-075 (BL-053 family). The orchestrator provisions a per-task git worktree and forwards it
// as the exec `cwd`; llm-agent puts it in the executor's sink. The persistent executors (gemini,
// codex) honour it -- the ONE-SHOT executor dropped it, so goose ran in the workdir's MAIN tree
// and the assigned `agentalk-task-<id>` worktree stayed empty. That is what made a good rung-4
// run look like "no work" when the reviewer checked the assigned worktree (the BL-059 trap).
//
// These tests do NOT mock the spawn. They shadow the real `goose` binary on PATH with a stub
// that reports the directory it was actually started in, so what is asserted is the working
// directory of a genuinely spawned child process.

const dirs = [];
const origPath = process.env.PATH;

// A stub `goose` that emits goose-shaped JSON whose assistant text is its own cwd.
// Real goose prints an ASCII banner before the JSON; parseGooseJson slices from the first '{'.
const installFakeGoose = () => {
  const binDir = mkdtempSync(path.join(tmpdir(), 'bl075-bin-'));
  dirs.push(binDir);
  const script = `#!/bin/sh
printf '    __( O)>  fake goose\\n'
printf '{"messages":[{"role":"assistant","content":[{"type":"text","text":"%s"}]}],"metadata":{"total_tokens":1,"input_tokens":1,"output_tokens":0,"status":"completed"}}\\n' "$PWD"
`;
  const file = path.join(binDir, 'goose');
  writeFileSync(file, script);
  chmodSync(file, 0o755);
  process.env.PATH = `${binDir}:${origPath}`;
  return binDir;
};

const makeTaskDir = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'bl075-task-'));
  dirs.push(d);
  return d;
};

// macOS resolves /var -> /private/var, so compare on the realpath.
const real = (p) => realpathSync(p);

afterEach(() => {
  process.env.PATH = origPath;
  while (dirs.length) {
    try { rmSync(dirs.pop(), { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('BL-075 one-shot executor honours the assigned task worktree', () => {
  it('D2: callProvider spawns the child in the cwd it was given', async () => {
    installFakeGoose();
    const taskDir = makeTaskDir();

    const { response } = await callProvider('goose', 'openai/gpt-4o-mini', 'where are you', {
      cwd: taskDir,
    });

    expect(real(response.trim())).toBe(real(taskDir));
    expect(real(response.trim())).not.toBe(real(process.cwd()));
  });

  it('D3: with no assigned cwd it still runs in our own cwd (pre-BL-075 behaviour preserved)', async () => {
    installFakeGoose();

    const { response } = await callProvider('goose', 'openai/gpt-4o-mini', 'where are you', {});

    expect(real(response.trim())).toBe(real(process.cwd()));
  });

  it('D1: the one-shot executor forwards sink.cwd all the way to the spawned child', async () => {
    installFakeGoose();
    const taskDir = makeTaskDir();

    // The real path a worker takes: llm-agent provisions the task dir and passes it as sink.cwd.
    const { executor } = createExecutor({ providerName: 'goose', selectedModel: 'openai/gpt-4o-mini' });
    await executor.initialize();
    const result = await executor.executeTurn(
      { id: 'bl075-1', prompt: 'where are you' },
      { onReplyChunk: () => {}, cwd: taskDir },
    );
    await executor.close();

    expect(real(result.response.trim())).toBe(real(taskDir));
  });
});
