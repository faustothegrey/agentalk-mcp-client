import { describe, it, expect } from 'vitest';
import { configDefaults } from 'vitest/config';
import config from '../vitest.config.mjs';

// `runs/` is gitignored scratch that live runs write into. Vitest's defaults
// collect it as tests, so one unrunnable scratch file reddens the suite while
// every real test passes. These bars guard the fix and the trap inside it.
describe('vitest config', () => {
  const exclude = config.test.exclude;

  it('does not collect the gitignored scratch directory as tests', () => {
    expect(exclude).toContain('runs/**');
  });

  it('still excludes vitest defaults — `exclude` REPLACES them, it does not extend', () => {
    // The trap: `exclude: ['runs/**']` alone looks correct and silently re-enables
    // collection of node_modules/**. Every default must survive.
    for (const def of configDefaults.exclude) {
      expect(exclude).toContain(def);
    }
    expect(exclude.some(p => p.includes('node_modules'))).toBe(true);
  });
});
