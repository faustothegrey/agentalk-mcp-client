import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

import { isMainModule } from '../lib/is-main.mjs';

/**
 * [[BL-113]] — the client-side mirror of [[BL-111]]. The entry guard that silently did nothing.
 *
 * `path.resolve(argv[1]) === fileURLToPath(import.meta.url)` compares a path with its symlinks
 * intact against one already resolved. On macOS `/tmp` → `/private/tmp`, so an absolute-path
 * invocation made `main` never run: **no output, exit 0**.
 *
 * This repo's instance guards **the launcher**, which the runbook mandates invoking by absolute
 * path and which a remote courier can invoke no other way — so a silent no-op meant a commissioned
 * run reported success and never started.
 *
 * Both bars are ported deliberately. The two repos keep separate copies of the helper (no shared
 * module graph); what must not drift is the behaviour, and only the bars can hold that.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every script that declares itself runnable. Discovered, not listed — a new one is covered free. */
function guardedScripts() {
  const dir = path.join(REPO_ROOT, 'scripts');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.mjs'))
    .filter((f) => fs.readFileSync(path.join(dir, f), 'utf-8').includes('isMainModule(import.meta.url)'));
}

describe('isMainModule', () => {
  it('is false when this module is IMPORTED, not run', () => {
    expect(isMainModule(import.meta.url)).toBe(false);
  });

  it('is false rather than throwing when argv[1] does not exist', () => {
    const saved = process.argv[1];
    try {
      process.argv[1] = '/definitely/not/here/xyz.mjs';
      expect(isMainModule(import.meta.url)).toBe(false);
    } finally {
      process.argv[1] = saved;
    }
  });

  it('is false rather than throwing when argv[1] is absent entirely', () => {
    const saved = process.argv[1];
    try {
      process.argv[1] = undefined;
      expect(isMainModule(import.meta.url)).toBe(false);
    } finally {
      process.argv[1] = saved;
    }
  });
});

describe('BAR A — every guarded script runs when invoked by a SYMLINKED absolute path', () => {
  const link = path.join(os.tmpdir(), `bl113-guard-${process.pid}`);

  it('finds scripts to test at all — an empty subject list would pass vacuously', () => {
    expect(guardedScripts().length).toBeGreaterThanOrEqual(1);
  });

  it.each(guardedScripts())('%s produces output through a symlink', (script) => {
    fs.rmSync(link, { force: true });
    fs.symlinkSync(REPO_ROOT, link);
    try {
      const viaLink = path.join(link, 'scripts', script);
      // If these matched, the bar would just be a normal invocation and would prove nothing.
      expect(path.resolve(viaLink)).not.toBe(fs.realpathSync(viaLink));

      let out;
      try {
        // No config argument: the launcher must reject that loudly. Silence is the failure mode
        // under test, and a usage error is a perfectly good proof that main() ran.
        out = execFileSync(process.execPath, [viaLink], {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 20000,
        });
      } catch (e) {
        out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
      }
      expect(out.trim(), `${script}: main() did not run — the entry guard rejected a symlinked argv[1]`).not.toBe('');
    } finally {
      fs.rmSync(link, { force: true });
    }
  });
});

describe('BAR B — the raw idiom appears nowhere', () => {
  it('no script or lib compares argv[1] to import.meta.url directly', () => {
    // The regression fence. BL-111's defining property was that the bug SPREAD by copy-paste, so
    // catching the next copy matters more than having fixed this one.
    const offenders = [];
    for (const dir of ['scripts', 'lib']) {
      const abs = path.join(REPO_ROOT, dir);
      if (!fs.existsSync(abs)) continue;
      for (const f of fs.readdirSync(abs).filter((x) => x.endsWith('.mjs'))) {
        fs.readFileSync(path.join(abs, f), 'utf-8')
          .split('\n')
          .forEach((line, i) => {
            const t = line.trim();
            if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return; // prose is not the bug
            if (/process\.argv\[1\]/.test(line) && /import\.meta\.url/.test(line)) {
              offenders.push(`${dir}/${f}:${i + 1}`);
            }
          });
      }
    }
    expect(offenders, 'use isMainModule() from lib/is-main.mjs instead').toEqual([]);
  });
});
