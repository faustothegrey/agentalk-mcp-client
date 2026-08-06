// BL-103 — every launched run leaked one branch and one stale worktree registration.
//
// `provisionTaskDir` does `git worktree add <dir> -b <branch>` and nothing ever undid it. The leak
// is silent and per-run, so it accumulates in proportion to how much the ladder is used — and a
// leaked `task-*` branch is indistinguishable at a glance from a real one, which is exactly the
// confusion the containment model exists to prevent.
//
// THE SAFETY PROPERTY IS THE DESIGN, and most of this file tests it rather than the happy path:
// cleanup must be incapable of destroying work. `worktree remove` without --force refuses a dirty
// tree; `branch -d` (never `-D`) refuses unmerged commits. Both refusals leave the thing in place
// and are reported. That is why BL-103's option (b) — "never create the branch, provision detached"
// — was NOT taken: detached commits go unreachable when the worktree is removed, trading a visible
// leak for silent data loss.
//
// Real repos throughout: the whole mechanism is git refusing things, and a mocked git would prove
// nothing about exactly that.

import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { provisionTaskDir, releaseTaskDirs } from '../lib/task-worktree.mjs';
import { createBite0Runner } from '../lib/bite0-launcher.mjs';

const tmp = [];
afterEach(() => { for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

// macOS: os.tmpdir() yields /var/folders/... while git reports the resolved /private/var/folders/...
// The implementation returns git's canonical path, which is correct; the test must compare like
// with like rather than the implementation being bent to match a platform quirk.
const real = (p) => fs.realpathSync(p);

function makeWorkdir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl103-'));
  tmp.push(dir);
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  fs.writeFileSync(path.join(dir, 'README.md'), 'base\n', 'utf8');
  git(dir, 'add', 'README.md');
  git(dir, '-c', 'user.name=T', '-c', 'user.email=t@e.com', 'commit', '-q', '-m', 'base');
  return dir;
}

const branches = (repo) => git(repo, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean);
const prunableCount = (repo) =>
  git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.trim() === 'prunable').length;

describe('BL-103 — releaseTaskDirs', () => {
  // The bar from the item, verbatim: "a full launch/teardown cycle leaves no new branch and no
  // prunable registration."
  it('the normal case: an empty task worktree leaves NO branch and NO prunable registration', () => {
    const workdir = makeWorkdir();
    const taskDir = provisionTaskDir('agentalk-task-123', workdir);
    const realTaskDir = real(taskDir);   // capture BEFORE release removes the directory
    expect(fs.existsSync(taskDir)).toBe(true);
    expect(branches(workdir)).toContain('task-123');

    const report = releaseTaskDirs(workdir);

    expect(report.removed).toEqual([realTaskDir]);
    expect(report.keptBranches).toEqual([]);
    expect(fs.existsSync(taskDir)).toBe(false);
    expect(branches(workdir)).not.toContain('task-123');
    expect(prunableCount(workdir)).toBe(0);
  });

  // ⭐ THE SAFETY BAR. A provider that really works in the task dir (gemini, one-shot) commits
  // there, and that branch is the only copy. `branch -d` must refuse it.
  it('a branch holding COMMITS survives — the directory goes, the history never does', () => {
    const workdir = makeWorkdir();
    const taskDir = provisionTaskDir('agentalk-task-work', workdir);
    const realTaskDir = real(taskDir);   // capture BEFORE release removes the directory
    fs.writeFileSync(path.join(taskDir, 'deliverable.md'), 'the work\n', 'utf8');
    git(taskDir, 'add', 'deliverable.md');
    git(taskDir, '-c', 'user.name=W', '-c', 'user.email=w@e.com', 'commit', '-q', '-m', 'worker work');
    const sha = git(taskDir, 'rev-parse', 'HEAD');

    const report = releaseTaskDirs(workdir);

    expect(report.removed).toEqual([realTaskDir]);          // directory cleaned up
    expect(report.keptBranches).toHaveLength(1);         // branch refused, and SAID so
    expect(report.keptBranches[0].branch).toBe('task-work');
    expect(branches(workdir)).toContain('task-work');
    // the commit is still reachable — this is the assertion the whole design exists for
    expect(git(workdir, 'rev-parse', 'task-work')).toBe(sha);
    expect(git(workdir, 'show', 'task-work:deliverable.md')).toBe('the work');
  });

  // ⭐ THE OTHER SAFETY BAR. Uncommitted work is not even on a branch yet.
  it('a task dir with UNCOMMITTED changes is not removed, and is reported', () => {
    const workdir = makeWorkdir();
    const taskDir = provisionTaskDir('agentalk-task-dirty', workdir);
    fs.writeFileSync(path.join(taskDir, 'in-progress.md'), 'half done\n', 'utf8');
    git(taskDir, 'add', 'in-progress.md');   // staged, never committed

    const report = releaseTaskDirs(workdir);

    expect(report.removed).toEqual([]);
    expect(report.keptDirs).toHaveLength(1);
    expect(report.keptDirs[0].dir).toBe(real(taskDir));
    expect(fs.existsSync(path.join(taskDir, 'in-progress.md'))).toBe(true);
    expect(branches(workdir)).toContain('task-dirty');   // its branch is still checked out
  });

  it('touches ONLY agentalk-task-* worktrees — anything else is somebody else\'s business', () => {
    const workdir = makeWorkdir();
    const other = path.join(workdir, 'unrelated-tree');
    execFileSync('git', ['-C', workdir, 'worktree', 'add', other, '-b', 'unrelated'], { stdio: 'ignore' });
    provisionTaskDir('agentalk-task-abc', workdir);

    releaseTaskDirs(workdir);

    expect(fs.existsSync(other)).toBe(true);
    expect(branches(workdir)).toContain('unrelated');
    expect(branches(workdir)).not.toContain('task-abc');
  });

  it('a workdir that is not a git repo is reported, never thrown', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'bl103-plain-'));
    tmp.push(plain);
    const report = releaseTaskDirs(plain);
    expect(report.errors).toHaveLength(1);
    expect(report.removed).toEqual([]);
  });
});

describe('BL-103 — the runner calls it', () => {
  const baseDeps = (over = {}) => ({
    startInstance: vi.fn(async () => ({})),
    launchAgent: vi.fn(async () => ({ agentId: 'worker-1', pid: 1 })),
    deliverGoal: vi.fn(async () => {}),
    waitForOutcome: vi.fn(async () => ({ result: 'done' })),
    terminateAgent: vi.fn(async () => {}),
    readMeterPercent: vi.fn(async () => 0),
    setTimer: vi.fn(() => 1),
    clearTimer: vi.fn(),
    stopInstance: vi.fn(async () => {}),
    report: vi.fn(async () => {}),
    logger: { error: () => {} },
    ...over,
  });
  const cfg = { instance: {}, agents: [{ id: 'worker-1', provider: 'claude', workdir: '/nowhere' }], goal: 'g', cap: { wallClockMs: 1000 } };

  it('releases task dirs and records the result in the run artifact', async () => {
    const events = [];
    const releaseTaskDirsDep = vi.fn(async () => ({ removed: ['/nowhere/agentalk-task-1'], keptDirs: [], keptBranches: [], errors: [] }));
    await createBite0Runner(baseDeps({ releaseTaskDirs: releaseTaskDirsDep, record: (e) => events.push(e) })).run(cfg);
    expect(releaseTaskDirsDep).toHaveBeenCalledWith(cfg.agents[0]);
    expect(events.find((e) => e.event === 'task-worktrees-released')).toMatchObject({ removed: ['/nowhere/agentalk-task-1'] });
  });

  // The dep is OPTIONAL on purpose: every caller that predates this behaves exactly as before.
  it('is a no-op when the dep is absent — existing callers are unchanged', async () => {
    const events = [];
    const res = await createBite0Runner(baseDeps({ record: (e) => events.push(e) })).run(cfg);
    expect(res).toMatchObject({ status: 'completed' });
    expect(events.find((e) => e.event === 'task-worktrees-released')).toBeUndefined();
  });

  // Cleanup that can fail a run is worse than the leak it fixes.
  it('a throwing release never breaks the run, and is recorded', async () => {
    const events = [];
    const res = await createBite0Runner(baseDeps({
      releaseTaskDirs: vi.fn(async () => { throw new Error('git exploded'); }),
      record: (e) => events.push(e),
    })).run(cfg);
    expect(res).toMatchObject({ status: 'completed' });
    expect(events.find((e) => e.event === 'task-worktrees-released')).toMatchObject({ errors: [{ step: 'call', detail: 'git exploded' }] });
  });

  // The runs nobody is watching are exactly the ones that must still be cleaned up.
  it('runs even when the worker fails', async () => {
    const events = [];
    await createBite0Runner(baseDeps({
      waitForOutcome: vi.fn(async () => { throw new Error('worker died'); }),
      releaseTaskDirs: vi.fn(async () => ({ removed: [], keptDirs: [], keptBranches: [], errors: [] })),
      record: (e) => events.push(e),
    })).run(cfg);
    expect(events.find((e) => e.event === 'task-worktrees-released')).toBeTruthy();
  });
});
