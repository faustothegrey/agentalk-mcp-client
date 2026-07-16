import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { provisionTaskDir } from '../lib/task-worktree.mjs';

// BL-053. The property under test is containment: a worker provisions its task worktree
// INSIDE the workdir it was assigned, and nothing the orchestrator sends can move it out.
// This is the guard on the defect that made BL-059 look like a lying model -- the worker
// worked in the orchestrator's repo, we looked in the workdir, and found nothing.

const dirs = [];
const makeRepo = () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'task-worktree-'));
  dirs.push(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
  writeFileSync(path.join(repo, 'README.md'), 'base\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: repo });
  return repo;
};

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe('provisionTaskDir (BL-053 containment)', () => {
  it('creates the task worktree inside the workdir, on its own branch', () => {
    const workdir = makeRepo();

    const taskDir = provisionTaskDir('agentalk-task-task-1', workdir);

    expect(taskDir).toBe(path.join(workdir, 'agentalk-task-task-1'));
    expect(existsSync(taskDir)).toBe(true);
    // A real worktree of THIS repo -- not just a directory.
    const list = execFileSync('git', ['worktree', 'list'], { cwd: workdir }).toString();
    expect(list).toContain(taskDir);
    // Pre-BL-053 branch naming preserved: dir agentalk-task-<id> -> branch task-<id>.
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: taskDir })
      .toString().trim();
    expect(branch).toBe('task-task-1');
  });

  it('refuses to be sent outside the workdir by an absolute path', () => {
    const workdir = makeRepo();
    const escape = path.join(tmpdir(), `bl053-escape-${Date.now()}`);

    // Exactly what the orchestrator used to send: an absolute path in ITS repo.
    const taskDir = provisionTaskDir(escape, workdir);

    expect(taskDir).toBe(path.join(workdir, path.basename(escape)));
    expect(taskDir.startsWith(workdir)).toBe(true);
    expect(existsSync(escape)).toBe(false); // nothing created out there
  });

  it('refuses to be sent outside the workdir by traversal', () => {
    const workdir = makeRepo();

    const taskDir = provisionTaskDir('../../../../tmp/bl053-traversal', workdir);

    expect(taskDir).toBe(path.join(workdir, 'bl053-traversal'));
    expect(taskDir.startsWith(workdir)).toBe(true);
  });

  // BL-061: fail closed. A task dir that was ASKED FOR and cannot be provided is a thrown error,
  // never a quiet substitution of the workdir root. BL-053 removed the prompt clause that asked
  // the agent to police this; these are what replaced it, and they are the reason that removal
  // was honest rather than merely convenient.
  it('throws on a name that is pure traversal, rather than provisioning anything', () => {
    const workdir = makeRepo();

    expect(() => provisionTaskDir('..', workdir)).toThrow(/refusing to provision/i);
  });

  it('throws -- rather than silently using the workdir root -- when the workdir is not a git repo', () => {
    const notARepo = mkdtempSync(path.join(tmpdir(), 'task-worktree-bare-'));
    dirs.push(notARepo);

    expect(() => provisionTaskDir('agentalk-task-task-9', notARepo))
      .toThrow(/could not provision task worktree/i);
  });

  it("carries git's own words into the failure, so the cause is readable", () => {
    const notARepo = mkdtempSync(path.join(tmpdir(), 'task-worktree-bare-'));
    dirs.push(notARepo);

    // A loud failure that cannot say WHY is just a quieter one.
    expect(() => provisionTaskDir('agentalk-task-task-9', notARepo)).toThrow(/not a git repository/i);
  });

  it('reuses an existing task dir instead of failing the turn', () => {
    const workdir = makeRepo();

    const first = provisionTaskDir('agentalk-task-task-2', workdir);
    const second = provisionTaskDir('agentalk-task-task-2', workdir);

    expect(second).toBe(first);
  });

  // BL-061: the other half of fail-closed, and the easier one to break. "No task dir asked for"
  // is NOT a failure -- planner-style turns (non-maintainsSession completers) legitimately carry
  // none and must keep running at the workdir root. Only "asked for and unavailable" is fatal.
  // Tightening the guard until this throws too would break every planner turn.
  it('returns undefined -- and does NOT throw -- when no task dir was asked for', () => {
    const workdir = makeRepo();

    expect(provisionTaskDir(undefined, workdir)).toBeUndefined();
    expect(() => provisionTaskDir(undefined, workdir)).not.toThrow();
  });

  it('does not throw for a missing task dir even when the workdir is not a git repo', () => {
    // The no-name path must never touch git at all: nothing was asked for, nothing can fail.
    const notARepo = mkdtempSync(path.join(tmpdir(), 'task-worktree-bare-'));
    dirs.push(notARepo);

    expect(provisionTaskDir(undefined, notARepo)).toBeUndefined();
    expect(provisionTaskDir('', notARepo)).toBeUndefined();
  });
});
