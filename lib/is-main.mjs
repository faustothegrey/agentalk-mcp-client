import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Was this module run as a script, or imported? — [[BL-113]], the client-side mirror of [[BL-111]].
 *
 * DELIBERATELY A SEPARATE COPY from AgentTalk's `scripts/lib/is-main.mjs`. The two repos share no
 * module graph, and inventing one for eleven lines would couple them far harder than the
 * duplication costs. What must NOT drift is the *behaviour*, which is why both carry the same bars.
 *
 * THE DEFECT IT REPLACES
 *   `path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)`
 *
 *   `path.resolve` normalises but does NOT resolve symlinks; `import.meta.url` is already real. On
 *   macOS `/tmp` is a symlink to `/private/tmp`, so invoking a script by an absolute path under
 *   `/tmp` compared two different strings, the guard read false, and **`main` never ran: no output,
 *   exit 0.** A silent no-op that reports success is worse than a crash — every caller checking an
 *   exit code reads it as "it worked".
 *
 * WHY IT MATTERS MORE HERE THAN ANYWHERE ELSE
 *   This file guards **the launcher**, and `design/launch-and-monitor-runbook.md` in AgentTalk
 *   mandates invoking it **by absolute path** — it is the only form a remote courier ([[BL-110]])
 *   can use. A silent no-op here means a commissioned operator run reports success and never
 *   starts, which is exactly what the first `hmp1` launch looked like from the outside before the
 *   cause was found.
 *
 *   It was not reachable when filed only because this repo does not sit under a symlinked path.
 *   That is a property of one machine's directory layout, not a safety property.
 *
 * IMPORT SAFETY — the reason the guard exists at all: the tests import `launcher.mjs` to drive the
 * real startInstance/stopInstance pair against a real process tree, and that must never
 * self-execute. Under vitest `argv[1]` is vitest's own entry, so this returns false.
 *
 * FAILS TO `false`, never throws: `realpathSync` throws on a missing path and an import must not be
 * able to crash on a guard. False is also the safe direction — a module that declines to run as a
 * script is inert; one that wrongly runs has side effects, and here those side effects boot an
 * orchestrator.
 *
 * @param {string} importMetaUrl - pass `import.meta.url` from the calling module
 * @returns {boolean}
 */
export function isMainModule(importMetaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(path.resolve(entry)) === fs.realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}
