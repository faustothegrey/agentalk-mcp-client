import path from 'path';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';

/**
 * BL-053: provision this turn's task worktree, INSIDE the worker's own workdir.
 *
 * The orchestrator sends a task-dir NAME (`agentalk-task-<id>`), not a path, and the worker
 * resolves it — because the worker is the only party that knows its workdir. In attach mode the
 * operator launches agents out-of-band, so the orchestrator never learns where they live
 * (`workdir` appears nowhere in the AgentTalk repo).
 *
 * `path.basename` is the fence, and it is the point of this function rather than defensive
 * dressing: whatever arrives — relative, absolute, or `../..`-traversing — the task dir can only
 * ever resolve INSIDE `workdir`. The orchestrator cannot send a worker somewhere else, by
 * construction. Before this, it sent an absolute `/tmp/agentalk-task-<id>` in its own repo, and
 * the provider that honoured it (gemini) left its workdir on every turn — which is how a worker's
 * committed work came to look like it had never happened (BL-059).
 *
 * @returns the absolute task dir, or `undefined` if it could not be provisioned (e.g. `workdir`
 *   is not a git repo). `undefined` means "run at the workdir root": no per-task isolation, but
 *   still contained.
 */
export function provisionTaskDir(name, workdir, { log = console.error } = {}) {
  if (!name) return undefined;

  const leaf = path.basename(name);
  // basename('..') === '..' — the one input that would still climb out.
  if (!leaf || leaf === '.' || leaf === '..') {
    log(`[llm-agent] refusing to provision a task worktree for name '${name}'.`);
    return undefined;
  }

  const taskDir = path.resolve(workdir, leaf);
  if (existsSync(taskDir)) return taskDir;

  // Preserves the pre-BL-053 branch name: dir `agentalk-task-<id>` -> branch `task-<id>`.
  const branch = leaf.replace(/^agentalk-/, '');
  try {
    execFileSync('git', ['worktree', 'add', taskDir, '-b', branch], {
      cwd: workdir,
      stdio: 'ignore',
    });
    return taskDir;
  } catch (err) {
    log(
      `[llm-agent] could not provision task worktree ${taskDir} (${err.message}); ` +
      `running this turn at the workdir root instead — no per-task isolation.`,
    );
    return undefined;
  }
}
