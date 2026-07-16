# AgentTalk MCP Client

This repository contains the standalone MCP client/worker for the AgentTalk system.

## Architecture

AgentTalk uses a strictly decoupled architecture:
1. **AgentTalk MCP Orchestrator** (External): A generic MCP Server that manages state, conversation tracking, and team orchestration. It has no knowledge of how specific LLMs work.
2. **AgentTalk MCP Client** (This Repo): Standalone worker processes that connect to the Orchestrator via a persistent WebSocket connection.

This client knows how to speak to respective LLM providers (Codex, Claude, Gemini via Antigravity) and translates those provider-specific capabilities into standard MCP interactions.

## Responsibilities

- **Provider Integration**: Formats prompts and parses responses for specific providers using dedicated pseudo-terminals (e.g., `codex-pty.mjs`, `claude-pty.mjs`, `gemini-pty.mjs`).
- **Turn Polling**: Connects to the generic Orchestrator via WebSocket and continuously polls for work using the `await_turn` tool.
- **Resilience**: Implements internal reconnect logic with exponential backoff. If the Orchestrator becomes unavailable, the client gracefully retries.

## On-demand launch (`agent-launcher`)

Instead of running `node llm-agent.mjs --agentId … --provider …` by hand for every agent, the
`agent-launcher` HTTP service launches agents on demand. On `POST /agents` it creates and starts the
agent in the orchestrator (via the orchestrator's existing HTTP API) and then spawns the `llm-agent`
harness locally, which attaches over WebSocket exactly as a manual launch would. The orchestrator itself
still launches nothing (the M05 attach-model invariant is preserved); the launcher is a separate process
that must run on the host where the provider CLIs live.

```bash
npm run launcher     # starts on 127.0.0.1:4100
```

| Method | Path            | Body                                                      | Result                          |
|--------|-----------------|-----------------------------------------------------------|---------------------------------|
| POST   | `/agents`       | `{ provider, model?, executionMode?, agentId?, workdir? }`| `201 { agentId, pid, status }`  |
| GET    | `/agents`       | —                                                         | `{ agents: [...] }`             |
| DELETE | `/agents/:id`   | —                                                         | `{ agentId, terminated }`       |
| GET    | `/healthz`      | —                                                         | `{ ok: true }`                  |

Config via env: `AGENT_LAUNCHER_PORT` (default `4100`), `AGENTTALK_ORCHESTRATOR_URL`
(default `http://localhost:3000`), `AGENTTALK_PERSISTENT_MCP_URL` (default `ws://localhost:3000/mcp`).

> **Security:** the launcher spawns local processes. It binds `127.0.0.1` only and must not be exposed on
> an external interface without an added auth layer.

## Bite 0 — autonomous capped run (`bite0-launcher`)

The first rung of the autonomous-development ladder. A **deterministic, config-driven** runner (`lib/bite0-launcher.mjs`)
that, with **no semantic inference**: starts the AgentTalk instance, launches the agent(s) the config declares (Bite 0:
exactly one) via the on-demand launcher above, delivers the config `goal` as the worker's first turn, **enforces a
machine-enforced cap** (wall-clock + resource meter — the anti-loop / anti-hang rail), and reports the outcome to the PO
**only when the run is finished**. On cap breach the worker is terminated and the run is marked `FAILED (capped)`.

> **Naming:** this deterministic runner is *the (AgentTalk) launcher*. **Hermes** is a separate, future *agent* layer
> (it will invoke this launcher and monitor a live session) — not part of Bite 0.

Config schema — see `bite0.config.example.json`:

```jsonc
{
  "instance": { "startCommand": {…}, "orchestratorUrl": "…", "mcpUrl": "…", "recording": "…" },
  "agents":   [ { "id": "worker-1", "provider": "claude", "role": "worker" } ],   // Bite 0: exactly one
  "goal":     "the bounded task, delivered as the worker's first turn",
  "cap":      { "wallClockMs": 600000, "pollIntervalMs": 5000,
                "meter": { "url": "http://127.0.0.1:9899", "provider": "claude", "field": "session", "maxPercentDelta": 5 } }
}
```

The PO expresses `{goal, team composition}` by writing this config; the launcher only *executes* it. The worker runs in a
per-task git worktree (via the launcher's `workdir`) — its changes reach `master` only by a PO-gated merge.

**Status:** the deterministic core + cap state-machine are unit-tested, and an E2E proves the core orchestrating the real
on-demand launcher + a real spawned harness, including a real wall-clock cap terminating a real hung process. The
production runner against a *live* AgentTalk instance + an authed provider CLI is the PO-babysat acceptance step.

## Contract Alignment & Hash Verification

Because the Orchestrator and the Client share no common codebase, they communicate using a strictly enforced, byte-identical wire contract.

### The Wire Contract
The committed wire-contract source of truth lives in the AgentTalk repo at `packages/contracts/wire-contract.json`. This client keeps a generated copy at `wire-contract.json` so it can advertise the current contract version and hash during the MCP initialize handshake.

To prevent silent drift, a cryptographic hash is checked during the initial MCP handshake:
1. Both systems compute a SHA-256 hash of their respective wire contract representation.
2. The client sends its hash to the Orchestrator during connection.
3. If the hashes mismatch, the connection is instantly rejected with a `1008 Policy Violation`.

### How to Realign with the Orchestrator
If the Orchestrator's protocol changes, realign this client from the AgentTalk source contract:
1. Run `npm run sync-contract` from this repo. By default it reads `../AgentTalk/packages/contracts/wire-contract.json`; set `AGENTTALK_CONTRACT_PATH=/absolute/path/to/wire-contract.json` for another checkout layout.
2. Run `npm run verify-contract` or `npm run build`. The verifier checks this client's hash and fails if the client copy diverges from the AgentTalk source when that source is available.
3. The client will then advertise the updated contract version and hash on its next connection.

*(Note: There is a one-way import guard enforced in lint/build to ensure no direct dependencies are ever created between this repo and the orchestrator).*
