import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBite0Runner, validateConfig, Bite0ConfigError } from '../lib/bite0-launcher.mjs';

// ---- deterministic fake timers ---------------------------------------------
function makeFakeTimers() {
  let seq = 0;
  const entries = new Map(); // id -> { ms, cb, live }
  return {
    setTimer: (ms, cb) => { const id = ++seq; entries.set(id, { ms, cb, live: true }); return id; },
    clearTimer: (id) => { const e = entries.get(id); if (e) e.live = false; },
    // fire the most-recent live timer whose ms matches
    fire: (ms) => {
      const hit = [...entries.entries()].reverse().find(([, e]) => e.live && e.ms === ms);
      if (!hit) throw new Error(`no live timer with ms=${ms}`);
      entries.get(hit[0]).live = false;
      hit[1].cb();
    },
    liveCount: () => [...entries.values()].filter((e) => e.live).length,
  };
}

const flush = () => new Promise((r) => setImmediate(r));

// controllable "worker outcome" deferred
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function baseDeps(over = {}) {
  const timers = makeFakeTimers();
  const deps = {
    startInstance: vi.fn(async () => ({ instance: true })),
    launchAgent: vi.fn(async () => ({ agentId: 'worker-1', pid: 4321 })),
    deliverGoal: vi.fn(async () => {}),
    waitForOutcome: vi.fn(() => new Promise(() => {})), // never settles unless overridden
    terminateAgent: vi.fn(async () => {}),
    readMeterPercent: vi.fn(async () => 0),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    stopInstance: vi.fn(async () => {}),
    report: vi.fn(async () => {}),
    logger: { error: () => {} },
    ...over,
  };
  return { deps, timers };
}

const cfg = (over = {}) => ({
  instance: {},
  agents: [{ id: 'worker-1', provider: 'claude', role: 'worker' }],
  goal: 'do the trivial task',
  cap: { wallClockMs: 600000, pollIntervalMs: 5000, meter: { maxPercentDelta: 5 } },
  ...over,
});

describe('validateConfig', () => {
  it('accepts a well-formed Bite-0 config', () => expect(validateConfig(cfg())).toBe(true));
  it('rejects missing goal', () => expect(() => validateConfig(cfg({ goal: '' }))).toThrow(Bite0ConfigError));
  it('rejects zero agents', () => expect(() => validateConfig(cfg({ agents: [] }))).toThrow(Bite0ConfigError));
  it('rejects more than one agent (Bite 0)', () =>
    expect(() => validateConfig(cfg({ agents: [{ provider: 'a' }, { provider: 'b' }] }))).toThrow(/exactly one/));
  it('rejects a non-positive wall-clock cap', () =>
    expect(() => validateConfig(cfg({ cap: { wallClockMs: 0 } }))).toThrow(Bite0ConfigError));
});

describe('bite0 runner', () => {
  afterEach(() => vi.restoreAllMocks());

  it('happy path: worker completes before the cap → COMPLETED; no terminate; instance stopped', async () => {
    const outcome = deferred();
    const { deps, timers } = baseDeps({ waitForOutcome: vi.fn(() => outcome.promise) });
    const runner = createBite0Runner(deps);
    const p = runner.run(cfg());
    await flush();
    // order: start → launch → deliver
    expect(deps.startInstance).toHaveBeenCalled();
    expect(deps.launchAgent).toHaveBeenCalled();
    expect(deps.deliverGoal).toHaveBeenCalledWith('worker-1', 'do the trivial task', expect.anything());
    // worker finishes
    outcome.resolve({ result: 'done ok' });
    const res = await p;
    expect(res).toMatchObject({ agentId: 'worker-1', status: 'completed', result: 'done ok' });
    expect(deps.terminateAgent).not.toHaveBeenCalled();
    expect(deps.report).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
    expect(deps.stopInstance).toHaveBeenCalled();
    expect(timers.liveCount()).toBe(0); // all cap timers cleared
  });

  it('wall-clock breach: hung worker is auto-terminated → FAILED (cap-wallclock)', async () => {
    const { deps, timers } = baseDeps(); // waitForOutcome never settles
    const runner = createBite0Runner(deps);
    const p = runner.run(cfg());
    await flush();
    timers.fire(600000); // wall-clock fires
    const res = await p;
    expect(res).toMatchObject({ status: 'failed', reason: 'cap-wallclock' });
    expect(deps.terminateAgent).toHaveBeenCalledWith('worker-1', expect.anything());
    expect(deps.report).toHaveBeenCalledWith(expect.objectContaining({ reason: 'cap-wallclock' }));
    expect(deps.stopInstance).toHaveBeenCalled();
  });

  it('meter breach: resource ceiling exceeded → FAILED (cap-resource) + terminate', async () => {
    // baseline read at start = 10; poll read = 16 → delta 6 ≥ 5
    const readMeterPercent = vi.fn().mockResolvedValueOnce(10).mockResolvedValue(16);
    const { deps, timers } = baseDeps({ readMeterPercent });
    const runner = createBite0Runner(deps);
    const p = runner.run(cfg());
    await flush();
    timers.fire(5000);   // poll tick → reads 16, delta 6 ≥ 5 → breach
    await flush();
    const res = await p;
    expect(res).toMatchObject({ status: 'failed', reason: 'cap-resource' });
    expect(deps.terminateAgent).toHaveBeenCalled();
  });

  it('meter under ceiling: poll re-arms, does not falsely breach', async () => {
    const readMeterPercent = vi.fn().mockResolvedValueOnce(10).mockResolvedValue(12); // delta 2 < 5
    const { deps, timers } = baseDeps({ readMeterPercent });
    const runner = createBite0Runner(deps);
    const p = runner.run(cfg());
    await flush();
    timers.fire(5000);   // poll → 12, delta 2 < 5 → re-arm, no breach
    await flush();
    expect(deps.terminateAgent).not.toHaveBeenCalled();
    expect(timers.liveCount()).toBeGreaterThan(0); // still waiting (wall-clock + re-armed poll)
    // cleanup: fire wall-clock to settle the run
    timers.fire(600000);
    await p;
  });

  it('worker error (not a cap breach) → FAILED (worker-error), no terminate', async () => {
    const outcome = deferred();
    const { deps } = baseDeps({ waitForOutcome: vi.fn(() => outcome.promise) });
    const runner = createBite0Runner(deps);
    const p = runner.run(cfg());
    await flush();
    outcome.reject(new Error('boom'));
    const res = await p;
    expect(res).toMatchObject({ status: 'failed', reason: 'worker-error' });
    expect(deps.terminateAgent).not.toHaveBeenCalled(); // only cap breaches terminate
    expect(deps.stopInstance).toHaveBeenCalled();
  });

  it('captures the meter baseline BEFORE launching the worker', async () => {
    const calls = [];
    const readMeterPercent = vi.fn(async () => { calls.push('meter'); return 0; });
    const launchAgent = vi.fn(async () => { calls.push('launch'); return { agentId: 'worker-1', pid: 1 }; });
    const { deps, timers } = baseDeps({ readMeterPercent, launchAgent });
    const runner = createBite0Runner(deps);
    const p = runner.run(cfg());
    await flush();
    expect(calls.indexOf('meter')).toBeLessThan(calls.indexOf('launch'));
    // settle the run via wall-clock so nothing dangles
    timers.fire(600000);
    await p;
  });
});
