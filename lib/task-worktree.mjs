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

/**
 * BL-103 — the other half of `provisionTaskDir`: give back what it took.
 *
 * `provisionTaskDir` does `git worktree add <dir> -b <branch>` and **nothing ever undid it**. Every
 * launched run therefore leaked one branch and one stale worktree registration, silently and in
 * proportion to how much the ladder was used — and a leaked `task-*` branch is indistinguishable at
 * a glance from a real one, which is exactly the confusion the containment model exists to prevent.
 *
 * ⛔ THE SAFETY PROPERTY, WHICH IS THE WHOLE DESIGN — this function CANNOT destroy work:
 *
 *   - `git worktree remove` WITHOUT `--force`  → refuses a directory with uncommitted changes.
 *   - `git branch -d` (never `-D`)             → refuses a branch holding unmerged commits.
 *
 * Both refusals are reported, not swallowed, and leave the thing in place. So the normal case (an
 * empty nested worktree — which is what claude produces, since its work lands in the parent
 * workdir) is cleaned up completely, and the case that matters (a provider that really worked in
 * the task dir and committed there) keeps its branch and therefore its commits. The directory may
 * go; the history never does.
 *
 * This is deliberately NOT BL-103's option (b), "never create the branch, provision detached".
 * Detached commits become unreachable the moment the worktree is removed and are then a GC away
 * from gone — trading a visible leak for silent data loss.
 *
 * Best-effort by construction: every git call is wrapped, and a failure is recorded rather than
 * thrown. Cleanup that can fail a run is worse than the leak it fixes.
 *
 * @param {string} workdir  the worker's workdir — the repo the task worktrees were added to.
 * @returns {{removed: string[], keptDirs: object[], keptBranches: object[], errors: object[]}}
 */
export function releaseTaskDirs(workdir) {
  const report = { removed: [], keptDirs: [], keptBranches: [], errors: [] };
  const git = (args) => execFileSync('git', args, { cwd: workdir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  let listing;
  try {
    listing = git(['worktree', 'list', '--porcelain']);
  } catch (err) {
    report.errors.push({ step: 'list', detail: (err.stderr?.toString() || err.message || '').trim() });
    return report;
  }

  // Only the worktrees this module creates. Anything else in the list is somebody else's business.
  const dirs = listing
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length).trim())
    .filter((d) => path.basename(d).startsWith('agentalk-task-'));

  for (const dir of dirs) {
    const branch = path.basename(dir).replace(/^agentalk-/, '');
    try {
      git(['worktree', 'remove', dir]);          // no --force: uncommitted work wins
      report.removed.push(dir);
    } catch (err) {
      report.keptDirs.push({ dir, reason: (err.stderr?.toString() || err.message || '').trim() });
      continue;                                   // its branch is still checked out; leave it alone
    }
    try {
      git(['branch', '-d', branch]);              // never -D: unmerged commits win
    } catch (err) {
      report.keptBranches.push({ branch, reason: (err.stderr?.toString() || err.message || '').trim() });
    }
  }

  try { git(['worktree', 'prune']); }
  catch (err) { report.errors.push({ step: 'prune', detail: (err.stderr?.toString() || err.message || '').trim() }); }

  return report;
}
