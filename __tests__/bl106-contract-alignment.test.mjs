import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

// BL-106 — the mirror of BL-101, in this repo. `verifySourceAlignment` resolved the AgentTalk
// contract as a sibling of its own script directory: correct only in the primary checkout.
// From a worktree it named a path that does not exist, and the fail-open branch turned "I
// could not look" into "everything is fine" — so the check was off wherever anyone works and
// on only where nobody does.
//
// INTEGRATION test on purpose, mirroring BL-101's: the defect is about resolution from inside
// a worktree, so a test that does not run in one proves nothing — the old code passes every
// unit-level assertion by not looking.

const SCRIPT_REL = 'scripts/verify-contract.js';

/** The primary checkout, correct from inside a worktree — the same primitive the fix uses. */
const primaryRoot = path.dirname(
    execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim(),
);
/** The checkout these tests run from (a worktree during development). */
const hereRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const sourceContract = path.resolve(primaryRoot, '../AgentTalk/packages/contracts/wire-contract.json');

function runScript(scriptPath, cwd, env = {}) {
    try {
        // process.execPath, not 'node': one test deliberately empties PATH, and resolving the
        // node binary through PATH would make that test fail for the wrong reason.
        const stdout = execFileSync(process.execPath, [scriptPath], {
            cwd, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { code: 0, out: stdout };
    } catch (err) {
        return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
}

describe('BL-106 — source alignment resolves from the primary checkout', () => {
    let worktree;

    beforeAll(() => {
        worktree = mkdtempSync(path.join(os.tmpdir(), 'bl106-wt-'));
        rmSync(worktree, { recursive: true, force: true });
        // --detach leaves no branch behind ([[BL-103]]: a worktree that leaks a branch per run
        // is its own filed defect; a test must not add to the pile).
        execFileSync('git', ['worktree', 'add', '--detach', '-q', worktree, 'HEAD'], { cwd: primaryRoot });
        // The worktree sits at HEAD, which does not contain uncommitted work. Copy the script
        // as it currently exists so the test exercises the version under development.
        copyFileSync(path.join(hereRoot, SCRIPT_REL), path.join(worktree, SCRIPT_REL));
    });

    afterAll(() => {
        if (!worktree) return;
        try { execFileSync('git', ['worktree', 'remove', worktree, '--force'], { cwd: primaryRoot }); } catch { /* already gone */ }
        try { execFileSync('git', ['worktree', 'prune'], { cwd: primaryRoot }); } catch { /* best effort */ }
        rmSync(worktree, { recursive: true, force: true });
    });

    it.runIf(existsSync(sourceContract))(
        'RUNS the alignment check from inside a worktree — the regression this fixes',
        () => {
            const { code, out } = runScript(path.join(worktree, SCRIPT_REL), worktree);
            // The exact string the old code printed instead. Observed live on 2026-07-30 from
            // the BL-102 worktree, which is what filed this item.
            expect(out).not.toMatch(/skipped source-alignment check/);
            expect(out).toMatch(/Source contract alignment verified|alignment verified/i);
            expect(code).toBe(0);
        },
    );

    it('still succeeds when run in place — no regression where it already worked', () => {
        const { code, out } = runScript(path.join(hereRoot, SCRIPT_REL), hereRoot);
        expect(out).toMatch(/Contract hash verified successfully/);
        expect(code).toBe(0);
    });

    it.runIf(existsSync(sourceContract))(
        'FAILS on a diverged source contract instead of passing quietly',
        () => {
            // The bar with teeth. A fail-open is exactly the class where a green proves
            // nothing, so this is only worth having once it has been watched to fail.
            const real = JSON.parse(readFileSync(sourceContract, 'utf8'));
            const doctored = { ...real, version: real.version + 1 };
            // Recompute the self-hash so we reach the DIVERGENCE branch rather than tripping
            // the hash check first — otherwise this would pass for the wrong reason.
            doctored.hash = createHash('sha256').update(JSON.stringify(doctored.data, null, 2)).digest('hex');
            const doctoredPath = path.join(worktree, 'doctored-source.json');
            writeFileSync(doctoredPath, JSON.stringify(doctored, null, 2));

            const { code, out } = runScript(path.join(worktree, SCRIPT_REL), worktree, {
                AGENTTALK_CONTRACT_PATH: doctoredPath,
            });
            expect(out).toMatch(/diverged/i);
            expect(code).not.toBe(0);
        },
    );

    it('falls back without throwing when git is unavailable', () => {
        // The original code could not crash resolving this path, and neither may the fix.
        const { code, out } = runScript(path.join(hereRoot, SCRIPT_REL), hereRoot, { PATH: '' });
        expect(out).not.toMatch(/Error:|ENOENT|Command failed/);
        expect(out).toMatch(/Contract hash verified successfully/);
        expect(code).toBe(0);
    });
});
