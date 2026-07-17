import { defineConfig, configDefaults } from 'vitest/config';

// Without a config, vitest's default include glob reaches into `runs/` — which is
// GITIGNORED SCRATCH (see .gitignore), not source. Anything a live run drops there
// gets collected as a test suite, and a scratch file that cannot resolve its
// imports fails COLLECTION, reddening the whole run while every real test passes.
//
// That is not hypothetical: `runs/rung15-probe-STALE-see-notes.test.ts` — an
// invalid rung-1.5 probe, written against *AgentTalk* paths and left here
// deliberately as the record of an invalid probe (BL-063) — produced a standing
// `1 failed | 12 passed` on master. It is a `.ts` file in a repo with no
// TypeScript, so it could never have run at all.
//
// The fix is at the class, not the instance: scratch is not a test suite. The
// probe stays on disk as the record; vitest simply stops collecting the scratch
// directory. Real tests live in `__tests__/`.
//
// NOTE: `exclude` REPLACES vitest's defaults rather than extending them, so
// `configDefaults.exclude` must be spread back in — dropping it would silently
// re-enable collection of node_modules/**.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'runs/**'],
  },
});
