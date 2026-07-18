import os from 'node:os';

/**
 * BL-071 P2 (client side) — capture a small, stable snapshot of the host THIS
 * agent process runs on. Ground truth the process observes about itself via
 * node's `os`/`process`; not a claim, so no trust model applies (that is BL-072).
 *
 * Mirrors the HostEnvironment shape defined in AgentTalk
 * (packages/contracts/src/types.ts) — kept in sync by hand, since the client is a
 * separate repo with no shared build. Same 8 fields, same meanings.
 *
 * @param {{ now?: () => number }} [options] injectable clock for `capturedAt` (tests)
 */
export function captureHostEnvironment(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  return {
    platform: os.platform(),
    arch: os.arch(),
    osRelease: os.release(),
    nodeVersion: process.version,
    hostname: os.hostname(),
    cpuCount: os.cpus().length,
    totalMemBytes: os.totalmem(),
    capturedAt: new Date(now()).toISOString(),
  };
}
