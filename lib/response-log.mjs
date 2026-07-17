// BL-064: the worker's report sink.
//
// The full model response exists for one instant in llm-agent (`result.response`) and then crosses
// MCP and is gone: the run recording holds lifecycle events only, and the worker is spawned
// stdio:'inherit', so whatever it printed reaches a terminal that no process can read back. Two
// rungs of the autonomous-development ladder were ungradable for exactly this reason — the artifact
// showed the answer and hid the thinking.
//
// This owns the decision of WHERE that report goes, so it can be tested without standing up an
// agent: the launcher hands down AGENTTALK_RESPONSE_LOG, and a report written there is filed with
// the run it belongs to.

import { createNdjsonRecorder } from './bite0-launcher.mjs';

/**
 * Build the response recorder for this process.
 *
 * Unset path => a no-op. That is the common case (a manual launch, no run recording), and it is
 * why this is a default rather than a required knob.
 *
 * Every write error is swallowed: observability must never be able to fail a turn. Losing the log
 * is bad; killing a real run to announce the loss is worse.
 *
 * @param {object} [env]  the environment to read (injectable for tests)
 * @param {object} [io]   { createRecorder(path), logError(msg) } — injectable for tests
 * @returns {(entry: object) => void}
 */
export function createResponseRecorder(env = process.env, io = {}) {
  const responseLogPath = env.AGENTTALK_RESPONSE_LOG;
  if (!responseLogPath) return () => {};

  const createRecorder = io.createRecorder ?? createNdjsonRecorder;
  const logError = io.logError ?? ((msg) => console.error(msg));

  let record;
  try {
    record = createRecorder(responseLogPath);
  } catch (err) {
    logError(`[llm-agent] Failed to open response log: ${err.message}`);
    return () => {};
  }

  return (entry) => {
    try {
      record(entry);
    } catch (err) {
      logError(`[llm-agent] Failed to record response: ${err.message}`);
    }
  };
}
