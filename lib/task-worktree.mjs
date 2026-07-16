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
 * BL-061 — FAIL CLOSED. If a task dir was asked for and cannot be provided, this THROWS; it does
 * not quietly hand back the workdir root. The distinction is the whole contract:
 *
 *   - no name asked for  -> `undefined`, meaning "run at the workdir root". Normal: planner-style
 *                           turns (non-`maintainsSession` completers) never carry a task dir.
 *   - name asked for     -> an absolute task dir, or a throw. Never a silent substitute.
 *
 * Why closed rather than degraded: BL-053 deleted the prompt clause that told the agent "use a
 * worktree or refuse", on the grounds that it asked an LLM to police an invariant the harness
 * guarantees — and it got that check wrong, refusing a *working* worktree. That argument is only
 * honest while the harness really does guarantee it. A silent degrade would leave the invariant
 * enforced by nobody: no clause, no check, and a turn running somewhere other than where the
 * orchestrator believes it runs. Deterministic enforcement is what earned the right to delete the
 * probabilistic one.
 *
 * Containment does not depend on this either way (the fence above is independent) — what a
 * degrade would silently drop is per-task *isolation*.
 *
 * @returns the absolute task dir, or `undefined` only when `name` is falsy.
 * @throws if a task dir was requested and could not be provisioned. The message carries git's own
 *   stderr, because a loud failure that cannot say why is just a quieter one.
 */
export function provisionTaskDir(name, workdir) {
  if (!name) return undefined;

  const leaf = path.basename(name);
  // basename('..') === '..' — the one input that would still climb out.
  if (!leaf || leaf === '.' || leaf === '..') {
    throw new Error(
      `refusing to provision a task worktree for name '${name}': it does not name a directory ` +
      `inside the workdir (${workdir}).`,
    );
  }

  const taskDir = path.resolve(workdir, leaf);
  if (existsSync(taskDir)) return taskDir;

  // Preserves the pre-BL-053 branch name: dir `agentalk-task-<id>` -> branch `task-<id>`.
  const branch = leaf.replace(/^agentalk-/, '');
  try {
    execFileSync('git', ['worktree', 'add', taskDir, '-b', branch], {
      cwd: workdir,
      // stderr piped, not ignored: git's own words ("not a git repository", "branch already
      // exists") are the actionable half of the failure.
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    return taskDir;
  } catch (err) {
    const gitSays = (err.stderr?.toString() || '').trim();
    throw new Error(
      `could not provision task worktree ${taskDir} in workdir ${workdir}` +
      (gitSays ? `: ${gitSays}` : ` (${err.message})`),
    );
  }
}
