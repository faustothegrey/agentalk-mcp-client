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
