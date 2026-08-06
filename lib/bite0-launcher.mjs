// Bite 0 — the (AgentTalk) launcher core.
//
// A DETERMINISTIC, config-driven runner (no semantic inference). Given a config it:
//   1. starts the AgentTalk instance,
//   2. launches every agent the config declares (Bite 0: exactly one) via the BL-037 launcher,
//   3. delivers the config `goal` as the worker's first turn,
//   4. enforces a machine-enforced cap (wall-clock + resource meter) — the anti-loop / anti-hang rail,
//   5. on done → COMPLETED; on cap breach → terminate the worker, FAILED (capped),
//   6. reports the outcome to the PO ONLY when the run is finished,
//   7. stops the instance and exits.
//
// Every side effect (start/launch/deliver/terminate/meter/timers/report/record) is injected, so the
// whole state machine is unit-testable with no real processes, network, or wall-clock.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Bite0ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'Bite0ConfigError';
  }
}

export function validateConfig(config) {
  if (!config || typeof config !== 'object') throw new Bite0ConfigError('config must be an object');
  if (!Array.isArray(config.agents) || config.agents.length === 0) {
    throw new Bite0ConfigError('config.agents must be a non-empty array');
  }
  if (config.agents.length !== 1) {
    throw new Bite0ConfigError(`Bite 0 supports exactly one agent (got ${config.agents.length})`);
  }
  if (!config.agents[0]?.provider) throw new Bite0ConfigError('config.agents[0].provider is required');
  if (typeof config.goal !== 'string' || !config.goal.trim()) throw new Bite0ConfigError('config.goal is required');
  if (!config.cap || typeof config.cap !== 'object') throw new Bite0ConfigError('config.cap is required');
  if (!(config.cap.wallClockMs > 0)) throw new Bite0ConfigError('config.cap.wallClockMs must be > 0');
  return true;
}

/**
 * @param {object} deps  injected effects:
 *   startInstance(instanceCfg) -> Promise<instanceHandle>
 *   launchAgent(agentCfg, instanceHandle) -> Promise<{ agentId, pid }>
 *   deliverGoal(agentId, goal, instanceHandle) -> Promise<void>
 *   waitForOutcome(agentId, instanceHandle) -> Promise<{ result }>   // resolves when the worker finishes
 *   terminateAgent(agentId, instanceHandle) -> Promise<void>
 *   readMeterPercent(meterCfg) -> Promise<number>                    // current % for the capped figure
 *   setTimer(ms, cb) -> handle ; clearTimer(handle)                  // injectable clock
 *   stopInstance(instanceHandle) -> Promise<void>
 *   report(outcome) -> Promise<void>                                 // end-of-run only
 *   record(entry) -> void|Promise<void>   (OPTIONAL)                 // per-run observability sink; see D6
 *   logger
 */
export function createBite0Runner(deps) {
  const required = ['startInstance', 'launchAgent', 'deliverGoal', 'waitForOutcome', 'terminateAgent',
    'readMeterPercent', 'setTimer', 'clearTimer', 'stopInstance', 'report'];
  for (const k of required) {
    if (typeof deps?.[k] !== 'function') throw new Error(`createBite0Runner requires a ${k} function`);
  }
  const logger = deps.logger ?? console;

  // Optional run-artifact sink (D6). Absent by default → a no-op, so every existing caller is unchanged.
  // Recording is BEST-EFFORT: a throwing/rejecting sink never disturbs the run (mirrors the meter rail).
  const record = typeof deps.record === 'function' ? deps.record : null;
  const emit = (entry) => {
    if (!record) return;
    try {
      const r = record(entry);
      if (r && typeof r.then === 'function') r.then(undefined, () => {});
    } catch { /* observability must never break the run */ }
  };

  // Resolve the cap: the earliest of (a) worker outcome, (b) wall-clock, (c) resource ceiling.
  function raceCapAndOutcome(config, agentId, instance) {
    const cap = config.cap;
    const pollMs = cap.pollIntervalMs ?? 5000;
    let wallHandle = null;
    let pollHandle = null;
    let settled = false;

    return new Promise((resolve) => {
      const finish = (outcome) => {
        if (settled) return;
        settled = true;
        if (wallHandle) deps.clearTimer(wallHandle);
        if (pollHandle) deps.clearTimer(pollHandle);
        resolve(outcome);
      };

      // (a) worker finishes on its own
      deps.waitForOutcome(agentId, instance).then(
        (r) => finish({ status: 'completed', result: r?.result ?? null }),
        (err) => finish({ status: 'failed', reason: 'worker-error', detail: err?.message ?? String(err) }),
      );

      // (b) wall-clock ceiling
      if (cap.wallClockMs > 0) {
        wallHandle = deps.setTimer(cap.wallClockMs, () => {
          finish({ status: 'failed', reason: 'cap-wallclock', detail: `exceeded ${cap.wallClockMs}ms` });
        });
      }

      // (c) resource ceiling — poll the meter for a delta from the baseline captured at launch.
      //
      // BL-117 (PO ruling 2026-08-05, option b): this rail WARNS, it does not terminate. The meter
      // reports MACHINE-WIDE per-provider percentages, so it cannot separate the worker's spend from
      // the supervising session's — it fires on the sum and attributes it to the worker. On hmp5 it
      // killed complete, verified work fourteen seconds after the commit. A shared-fate trigger is
      // not a containment rail, so the reading, the delta and the artifact record all stay; only the
      // authority to kill is removed. `cap.wallClockMs` is now the only terminating rail — and it is
      // the one actually proven to terminate (BL-096: real process, PID confirmed dead).
      if (cap.meter && typeof cap.meter.maxPercentDelta === 'number') {
        // BL-114: tri-state. A number, or null meaning UNKNOWN — never a fabricated 0.
        let baseline = typeof config.__meterBaseline === 'number' ? config.__meterBaseline : null;
        let warned = false;
        const poll = () => {
          if (settled) return;
          deps.readMeterPercent(cap.meter).then((pct) => {
            if (settled) return;
            // BL-114: an UNKNOWN baseline must never be compared against. The old code coerced a
            // failed baseline read to 0, so the first successful poll computed `pct - 0` — an
            // instant false breach on a worker that had spent nothing. Instead, the first reading
            // we can actually trust ESTABLISHES the baseline and makes no comparison. The rail arms
            // late rather than wrongly.
            if (baseline === null) {
              baseline = pct;
              emit({ event: 'meter-baseline-established', percent: pct, late: true });
              pollHandle = deps.setTimer(pollMs, poll);
              return;
            }
            const delta = pct - baseline;
            if (delta >= cap.meter.maxPercentDelta && !warned) {
              warned = true;   // once per run: this polls every few seconds and would otherwise spam
              emit({
                event: 'cap-warning',
                reason: 'meter',
                detail: `meter +${delta}% ≥ ${cap.meter.maxPercentDelta}%`,
                delta,
                threshold: cap.meter.maxPercentDelta,
                note: 'machine-wide per provider; NOT worker-attributable (BL-117). Warning only — the run continues.',
              });
            }
            pollHandle = deps.setTimer(pollMs, poll);
          }, (err) => {
            // meter read failed — best-effort, never blocking: skip this tick, keep the wall-clock rail.
            // BL-114: recorded, so a grader can write `unavailable` instead of silently reading a 0
            // that never happened.
            emit({ event: 'meter-unreadable', detail: err?.message ?? String(err) });
            if (!settled) pollHandle = deps.setTimer(pollMs, poll);
          });
        };
        pollHandle = deps.setTimer(pollMs, poll);
      }
    });
  }

  async function run(config) {
    validateConfig(config);
    emit({
      event: 'run-start',
      provider: config.agents[0]?.provider ?? null,
      goal: config.goal,
      cap: {
        wallClockMs: config.cap.wallClockMs,
        pollIntervalMs: config.cap.pollIntervalMs ?? null,
        meter: Boolean(config.cap.meter),
      },
    });
    const started = { instance: null, agentId: null };
    try {
      // 1. start instance
      started.instance = await deps.startInstance(config.instance ?? {});
      logger.error?.('[bite0] instance started');

      // capture the meter baseline BEFORE the worker burns resources
      if (config.cap.meter && typeof deps.readMeterPercent === 'function') {
        // BL-114: a failed baseline read is UNKNOWN (null), never 0. Coercing it to 0 was the more
        // dangerous half of the fail-open: with a real reading arriving later, `pct - 0` is a breach
        // on the first successful poll. The rail re-establishes its baseline from the first
        // trustworthy reading instead (see raceCapAndOutcome).
        try { config.__meterBaseline = await deps.readMeterPercent(config.cap.meter); }
        catch (err) {
          config.__meterBaseline = null;
          emit({ event: 'meter-baseline-unavailable', detail: err?.message ?? String(err) });
        }
      }

      // 2. launch the (single) declared agent
      const launched = await deps.launchAgent(config.agents[0], started.instance);
      started.agentId = launched?.agentId ?? config.agents[0].id;
      logger.error?.(`[bite0] launched agent ${started.agentId} (pid ${launched?.pid})`);
      emit({ event: 'agent-launched', agentId: started.agentId, pid: launched?.pid ?? null });

      // 3. deliver the goal as the worker's first turn
      await deps.deliverGoal(started.agentId, config.goal, started.instance);
      emit({ event: 'goal-delivered', agentId: started.agentId });

      // 4. race cap vs outcome
      const outcome = await raceCapAndOutcome(config, started.agentId, started.instance);

      // 5. on any cap breach, terminate the worker
      if (outcome.status === 'failed' && String(outcome.reason).startsWith('cap-')) {
        emit({ event: 'cap-breach', agentId: started.agentId, reason: outcome.reason, detail: outcome.detail ?? null });
        try { await deps.terminateAgent(started.agentId, started.instance); } catch (e) { logger.error?.(`[bite0] terminate failed: ${e?.message}`); }
      }

      // 6. report — end of run only
      const finalOutcome = { agentId: started.agentId, ...outcome };
      emit({ event: 'outcome', ...finalOutcome });
      await deps.report(finalOutcome);
      return finalOutcome;
    } finally {
      // 7. stop the instance
      if (started.instance) {
        try { await deps.stopInstance(started.instance); } catch (e) { logger.error?.(`[bite0] stopInstance failed: ${e?.message}`); }
      }
    }
  }

  return { run };
}

/**
 * Default run-artifact sink (D6): an append-only NDJSON recorder honoring `config.instance.recording`.
 * One JSON object per line, each stamped with an ISO timestamp at write time — the core stays pure
 * (no clock), the impurity (time + fs) lives here at the edge. Wire it as `deps.record`.
 *
 * @param {string} filePath  where to append (parent dirs are created on first write)
 * @param {object} [io]  { now(): string, appendFile(path, data): void }  — injectable for tests
 */
export function createNdjsonRecorder(filePath, io = {}) {
  const now = io.now ?? (() => new Date().toISOString());
  const appendFile = io.appendFile ?? appendFileSync;
  let dirEnsured = false;
  return function record(entry) {
    if (!dirEnsured) {
      try { mkdirSync(dirname(filePath), { recursive: true }); } catch { /* dir may already exist */ }
      dirEnsured = true;
    }
    appendFile(filePath, JSON.stringify({ t: now(), ...entry }) + '\n');
  };
}
