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
The definition of what a "turn" looks like and what a "reply" looks like is defined in `lib/protocol-payloads.js` (vendored bridge). This is a copy from the Orchestrator's `packages/runtime-core/src/protocol/protocol-payloads.ts`.

To prevent silent drift, a cryptographic hash is checked during the initial MCP handshake:
1. Both systems compute a SHA-256 hash of their respective wire contract representation.
2. The client sends its hash to the Orchestrator during connection.
3. If the hashes mismatch, the connection is instantly rejected with a `1008 Policy Violation`.

### How to Realign with the Orchestrator
If the Orchestrator's protocol changes, you **must** realign this client:
1. Run the alignment script or manually copy the updated types from the Orchestrator.
2. Ensure `wire-contract.json` or `lib/protocol-payloads.js` equivalent representation matches identically.
3. The new hash will then match the Orchestrator's updated hash, allowing connections to succeed.

*(Note: There is a one-way import guard enforced in lint/build to ensure no direct dependencies are ever created between this repo and the orchestrator).*
