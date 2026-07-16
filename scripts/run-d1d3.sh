#!/usr/bin/env bash
# Drive the BL-040 D1/D3 live slice: real orchestrator + fake-bridge worker + wall-clock cap.
set -u
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
mkdir -p runs

# Point the worker's executor at the fake bridge (healthcheck_ack only → attach, then park).
export AGENTTALK_PERSISTENT_COMMAND_JSON="{\"command\":\"node\",\"args\":[\"${ROOT}/scripts/fake-worker-bridge.cjs\"]}"

# Clean any stray orchestrator.
pkill -9 -f "orchestrator/dist/index.js" 2>/dev/null || true
sleep 1

echo "=== BL-040 D1/D3 live run ==="
echo "bridge env: ${AGENTTALK_PERSISTENT_COMMAND_JSON}"
timeout 45 node scripts/launcher.mjs scripts/bl040-d1d3.config.json
code=$?
echo "=== launcher exit code: ${code} (1=FAILED/capped expected, 124=timeout) ==="

# Best-effort cleanup of any lingering orchestrator.
pkill -9 -f "orchestrator/dist/index.js" 2>/dev/null || true
exit 0
