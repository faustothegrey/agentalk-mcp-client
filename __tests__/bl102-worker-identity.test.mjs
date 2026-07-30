import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getSpawnEnv, workerGitIdentityEnv } from '../lib/provider-runtime.mjs';

const libDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib');

// BL-102 — an autonomous worker's commits were authored under the PO's git identity, so in
// history agent work was indistinguishable from the human's. The fix sets GIT_AUTHOR_* and
// GIT_COMMITTER_* on the worker PROCESS, because where a worker commits depends on its
// execution path (claude/persistent commits in the assigned workdir; every other provider in
// the provisioned task worktree), and a directory-scoped fix necessarily misses one of them.
describe('BL-102 — worker git identity', () => {
    const saved = process.env.AGENTTALK_AGENT_ID;
    beforeEach(() => { process.env.AGENTTALK_AGENT_ID = 'worker-7'; });
    afterEach(() => {
        if (saved === undefined) delete process.env.AGENTTALK_AGENT_ID;
        else process.env.AGENTTALK_AGENT_ID = saved;
    });

    it('names the agent, not the human, and sets committer as well as author', () => {
        const env = workerGitIdentityEnv('claude');
        expect(env.GIT_AUTHOR_NAME).toBe('AgentTalk worker (claude)');
        expect(env.GIT_AUTHOR_EMAIL).toBe('agent+worker-7@agenttalk.local');
        // The committer field is not decoration: `--author` alone leaves it claiming a human,
        // and it is the field that survives a rebase.
        expect(env.GIT_COMMITTER_NAME).toBe(env.GIT_AUTHOR_NAME);
        expect(env.GIT_COMMITTER_EMAIL).toBe(env.GIT_AUTHOR_EMAIL);
    });

    it('degrades to a non-human identity when the agent id is absent', () => {
        delete process.env.AGENTTALK_AGENT_ID;
        // Still unmistakably not a person — the failure mode must never be "looks human".
        expect(workerGitIdentityEnv('codex').GIT_AUTHOR_EMAIL).toBe('agent+unknown@agenttalk.local');
    });

    // T-2: the task-worktree provider path. gemini/codex/goose cannot be launched here (PO
    // declared them unavailable; goose is not installed), so this path is pinned by unit test
    // rather than by a live run — deliberately, not as a substitute that was easier to get.
    it('reaches the one-shot / task-worktree spawn path via getSpawnEnv', () => {
        expect(getSpawnEnv('gemini').GIT_AUTHOR_EMAIL).toBe('agent+worker-7@agenttalk.local');
        expect(getSpawnEnv('claude').GIT_AUTHOR_EMAIL).toBe('agent+worker-7@agenttalk.local');
    });

    it('returns a COPY for every provider, never process.env by reference', () => {
        // Previously this returned process.env by reference for non-claude and a copy only for
        // claude, so a caller adding to the result mutated this process's own environment for
        // some providers and not others.
        for (const provider of ['claude', 'gemini', 'codex']) {
            const env = getSpawnEnv(provider);
            expect(env).not.toBe(process.env);
            env.__BL102_PROBE__ = '1';
            expect(process.env.__BL102_PROBE__).toBeUndefined();
        }
    });

    it('preserves the pre-existing ANTHROPIC_API_KEY behaviour exactly', () => {
        process.env.ANTHROPIC_API_KEY = 'sk-test';
        try {
            expect(getSpawnEnv('claude').ANTHROPIC_API_KEY).toBeUndefined();
            expect(getSpawnEnv('gemini').ANTHROPIC_API_KEY).toBe('sk-test');
        } finally {
            delete process.env.ANTHROPIC_API_KEY;
        }
    });

    // T-4: the row that fails when a NEW spawn site is added without the identity. The defect
    // class here is silent — a missed site produces commits that look exactly like correct
    // ones — so the guard is structural rather than behavioural.
    it('leaves no worker spawn site passing a bare process.env', () => {
        for (const file of ['executor-runtime.mjs', 'provider-runtime.mjs']) {
            const src = readFileSync(join(libDir, file), 'utf8');
            expect(src, `${file} still passes process.env by reference to a spawn`)
                .not.toMatch(/env:\s*process\.env\s*,/);
        }
    });

    // T-3's structural half: the fix must not write git config anywhere. `git config` inside a
    // LINKED WORKTREE is not worktree-scoped — it writes the shared common config, so an agent
    // identity set that way rewrites the PRIMARY checkout's identity and the human's own later
    // commits would be authored as an agent. The live half of T-3 compares config before/after.
    it('never shells out to git at all, so no config can be written', () => {
        for (const file of ['executor-runtime.mjs', 'provider-runtime.mjs']) {
            const src = readFileSync(join(libDir, file), 'utf8');
            expect(src, `${file} invokes git`).not.toMatch(/(?:spawn|execFile|execFileSync|exec)\(\s*['"`]git['"`]/);
        }
    });
});
