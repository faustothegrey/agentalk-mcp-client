import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, lstatSync, readFileSync, copyFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { primaryCheckout, provisionNodeModules } from '../scripts/wt-setup.mjs';

// BL-105 — a `git worktree add` in this repo produces a checkout with no `node_modules`, and the
// first command run there dies with `sh: vitest: command not found`. The worktree MANDATE says all
// code development happens in a per-task worktree, so that is every development checkout.
//
// INTEGRATION on purpose, in a REAL fresh worktree — mirroring BL-106's test for the same reason.
// The defect only exists in a checkout git just made; a test that runs anywhere else is running in
// a directory somebody already provisioned by hand, which is precisely the dance under repair. Unit
// assertions about a symlink helper would pass on both sides of this fix.

const SCRIPT_REL = 'scripts/wt-setup.mjs';

/**
 * The files this change touches. A test worktree is created at `HEAD` of the primary, which does
 * not contain uncommitted work, so these are copied in from the checkout under development —
 * BL-106's test does the same for its one file. `.gitignore` is here because the fix is not only
 * the script: the ignore rule said `node_modules/`, and a trailing slash does not match the
 * SYMLINK the script creates.
 */
const UNDER_DEVELOPMENT = [SCRIPT_REL, '.gitignore'];

/**
 * The primary checkout, derived by a DIFFERENT primitive than the tool under test uses
 * (`--git-common-dir`, as `scripts/verify-contract.js` does for BL-106, versus the tool's
 * `worktree list --porcelain`). Two independent derivations agreeing is worth something; a test
 * that borrows the implementation's own answer only proves the code equals itself.
 */
const primaryRoot = path.dirname(
    execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim(),
);
/** The checkout these tests run from (a worktree during development). */
const hereRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

function addWorktree(dir, extraArgs) {
    rmSync(dir, { recursive: true, force: true });
    execFileSync('git', ['worktree', 'add', ...extraArgs, '-q', dir, 'HEAD'], { cwd: primaryRoot });
    for (const file of UNDER_DEVELOPMENT) copyFileSync(path.join(hereRoot, file), path.join(dir, file));
}

function dropWorktree(dir, branch) {
    if (!dir) return;
    try { execFileSync('git', ['worktree', 'remove', dir, '--force'], { cwd: primaryRoot }); } catch { /* already gone */ }
    try { execFileSync('git', ['worktree', 'prune'], { cwd: primaryRoot }); } catch { /* best effort */ }
    // BL-103: a worktree that leaks a branch per run is its own filed defect; a test must not add to it.
    if (branch) try { execFileSync('git', ['branch', '-D', branch], { cwd: primaryRoot }); } catch { /* none left */ }
    rmSync(dir, { recursive: true, force: true });
}

function run(args, cwd, env = {}) {
    try {
        // process.execPath, not 'node': the child must be this same runtime regardless of PATH.
        const stdout = execFileSync(process.execPath, args, {
            cwd, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { code: 0, out: stdout };
    } catch (err) {
        return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
}

/** The exact resolution `vitest.config.mjs` performs on line 1, from `dir`. */
function vitestResolvesFrom(dir) {
    return run(['--input-type=module', '-e', 'await import("vitest/config")'], dir).code === 0;
}

describe('BL-105 — a fresh worktree is runnable after wt-setup', () => {
    let worktree;

    beforeAll(() => {
        worktree = mkdtempSync(path.join(os.tmpdir(), 'bl105-wt-'));
        // --detach leaves no branch behind.
        addWorktree(worktree, ['--detach']);
    });

    afterAll(() => dropWorktree(worktree));

    it('starts out BROKEN — no node_modules, and vitest cannot resolve', () => {
        // The defect itself, asserted before the repair rather than described in a comment. If this
        // ever stops holding, `git worktree add` has changed and this whole item is moot.
        expect(existsSync(path.join(worktree, 'node_modules'))).toBe(false);
        expect(vitestResolvesFrom(worktree)).toBe(false);
    });

    it('provisions it so the real vitest binary runs there', () => {
        const { code, out } = run([path.join(worktree, SCRIPT_REL)], worktree);
        expect(out).toMatch(/linked .*node_modules/);
        expect(code).toBe(0);

        expect(vitestResolvesFrom(worktree)).toBe(true);
        // `sh: vitest: command not found` was the observed failure; this is the command that
        // produced it, run for real.
        const version = run([path.join(worktree, 'node_modules/.bin/vitest'), '--version'], worktree);
        expect(version.code).toBe(0);
    });

    it('leaves every TRACKED file untouched, and no untracked dirt of its own', () => {
        const status = execFileSync('git', ['status', '--porcelain'], { cwd: worktree, encoding: 'utf8' });
        const lines = status.trim().split('\n').filter(Boolean);

        // Git may report only the files the HARNESS copied in above. Everything else git can see
        // in this worktree is the tool's doing, and the tool must leave nothing.
        const stray = lines.filter((line) => !UNDER_DEVELOPMENT.some((file) => line.endsWith(file)));
        expect(stray).toEqual([]);

        // The BL-100 fence, named explicitly because it is the one that bites: anything that ran an
        // install would resync the lockfile and leave a modified TRACKED file here, on every future
        // run, for everyone.
        expect(status).not.toMatch(/package-lock\.json/);

        // And the link itself must be IGNORED, not merely harmless — otherwise every worktree
        // carries a permanent `?? node_modules`, and one `git add -A` commits the symlink.
        expect(status).not.toMatch(/node_modules/);
    });

    it('is idempotent — a second run changes nothing and still succeeds', () => {
        const { code, out } = run([path.join(worktree, SCRIPT_REL)], worktree);
        expect(out).toMatch(/already points at/);
        expect(code).toBe(0);
        expect(vitestResolvesFrom(worktree)).toBe(true);
    });
});

describe('BL-105 — derivation, not configuration', () => {
    it('derives the primary checkout, agreeing with an independent primitive', () => {
        expect(realpathSync(primaryCheckout())).toBe(realpathSync(primaryRoot));
    });

    it('finds the primary from inside a worktree, not just from the primary', () => {
        // The BL-101/BL-106 failure mode is a resolution that is right from one checkout and
        // silently wrong from another, so "it works where I ran it" is not evidence.
        expect(realpathSync(primaryCheckout(hereRoot))).toBe(realpathSync(primaryRoot));
    });

    it('hardcodes no path specific to one machine', () => {
        // BL-100's other half was exactly such a literal, and it made the sibling tool unusable on
        // another platform.
        const source = readFileSync(path.join(hereRoot, SCRIPT_REL), 'utf8');
        expect(source).not.toMatch(/\/Users\//);

        // Comments stripped first: the check is about what the CODE resolves, and the prose
        // legitimately names `/tmp` and `/private/tmp` when explaining BL-113's symlink lesson.
        const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        expect(code).not.toMatch(/['"`]\/(Users|home|private|tmp|var|opt)\b/);
    });
});

describe('BL-105 — what it refuses to do', () => {
    it('refuses the primary checkout and leaves its real node_modules alone', () => {
        const before = lstatSync(path.join(primaryRoot, 'node_modules'));
        const { code, out } = run([path.join(hereRoot, SCRIPT_REL), primaryRoot], hereRoot);
        expect(out).toMatch(/refusing to provision the primary checkout/);
        expect(code).toBe(1);

        const after = lstatSync(path.join(primaryRoot, 'node_modules'));
        expect(after.isDirectory()).toBe(true);
        expect(after.isSymbolicLink()).toBe(false);
        expect(after.ino).toBe(before.ino);
    });

    it('refuses a primary with no install rather than running one', () => {
        // Where a lesser tool would "helpfully" npm install and dirty the lockfile.
        const emptyPrimary = mkdtempSync(path.join(os.tmpdir(), 'bl105-noinstall-'));
        const target = path.join(emptyPrimary, 'wt');
        try {
            expect(() => provisionNodeModules(target, emptyPrimary))
                .toThrow(/has no node_modules[\s\S]*will not run it for you/);
        } finally {
            rmSync(emptyPrimary, { recursive: true, force: true });
        }
    });

    it('never deletes a real node_modules directory it did not create', () => {
        const fake = mkdtempSync(path.join(os.tmpdir(), 'bl105-own-'));
        try {
            const target = path.join(fake, 'wt', 'node_modules');
            execFileSync('mkdir', ['-p', target]);
            const result = provisionNodeModules(path.join(fake, 'wt'), primaryRoot);
            expect(result.status).toBe('own-install');
            expect(lstatSync(target).isDirectory()).toBe(true);
        } finally {
            rmSync(fake, { recursive: true, force: true });
        }
    });
});

describe('BL-105 — one command from nothing to runnable', () => {
    const branch = 'bl105-created-wt';
    let created;

    afterAll(() => dropWorktree(created, branch));

    it('creates the worktree when the path does not exist yet, then provisions it', () => {
        // The developer-facing shape: from the primary, one command produces a checkout that runs.
        created = path.join(mkdtempSync(path.join(os.tmpdir(), 'bl105-new-')), 'wt');
        const { code, out } = run([path.join(hereRoot, SCRIPT_REL), created, branch], hereRoot);
        expect(out).toMatch(/created worktree/);
        expect(code).toBe(0);
        expect(vitestResolvesFrom(created)).toBe(true);
    });
});
