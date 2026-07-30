> **Canonical file.** `AGENT.md` is the single source; **`AGENTS.md` and `CLAUDE.md` are symlinks to it**
> (one file, three names for different tools). **Edit `AGENT.md` only.**

# agentalk-mcp-client — rules of engagement

**This repo is the client half of AgentTalk.** It holds the agent **launcher**, the provider **executors**
(claude / codex / gemini-agy / goose), the **MCP bridge** that carries tool calls back to the orchestrator, and
the **wire contract** both halves must agree on. The orchestrator, the design docs, the backlog and the
development method live in the **AgentTalk** repo alongside this one.

**Read this file before changing anything here.** It is short on purpose: it carries the rules that bind, and
nothing else. Everything below applies to *any* agent working in this repo, whether launched autonomously or
driven by a human.

---

## Honesty over Results

- **Do not optimize for "passing" at all costs.** It is not the final result that matters most, but following
  instructions exactly and being completely honest about the state of the system.
- **Report the actual command output, not a remembered or optimistic summary.** Never claim a test suite or
  command passed without actually running it and reading the final output. Do not hallucinate test results or
  assume that because it compiles, it passes.
- **Never fix things silently.** If something is broken, doesn't add up, or requires an ugly hack (like a sleep
  in production) to work, **STOP AND RAISE IT**. Do not bury the problem to make a test pass.
- **Transparency is the goal.** A failing test with a clear, honest explanation of the obstacle is immensely
  more valuable than a green test achieved through a dirty hack.

---

## ⛔ Implementer Rules of Engagement ⛔ *(non-negotiable)*

**1. "Done" is NOT "tests green."** Done = the change works **as specified**, **strictly within scope**, with
**all prior behaviour preserved**, **and honestly reported**. A green obtained by changing anything outside
scope, weakening a test, or altering existing behaviour is a **REJECTED delivery**. **A blocker reported clearly
is a COMPLETED deliverable for the round** — you are *not* penalised for an honest red; you *are* rejected for a
scope-creep green.

**2. ANY non-trivial behaviour change is a SHOW-STOPPER — report it, don't make it.** A behaviour change is
*anything* that alters how the app behaves — **including fixing a bug you discover.** You may make one **only**
if it is **completely trivial AND provably safe**, which means: **you can exactly predict *every* ramification
and are certain *all* are acceptable.** Any uncertainty, anything non-trivial, anything touching shared logic →
**STOP. Do NOT change it. Report it.** **Finding a bug is your job; *fixing* it is not** — other already-passed
work depends on the current behaviour. **When in doubt, it is a show-stopper.** Touch only the files your task
names.

*In this repo specifically, the shared logic that triggers this rule is:* the **wire contract**
(`wire-contract.json` — both halves must agree, and a mismatch is silent until the handshake), the **executors**
and the **MCP bridge**, and anything altering the launcher's process, port or worktree behaviour.

**3. Persist WITHIN the box; never make the box bigger.** Don't give up on the first failure — debug, retry, fix
**within scope** (≈3 honest attempts). But **never** persist by *broadening scope*, *changing existing
behaviour*, or *weakening a test* to force a pass. When still blocked after honest attempts: **STOP and report
the blocker** with a precise diagnosis.

**4. Try-it / test-it / report-it — don't reshape reality.** Run things **as they are**. See if they work. Test.
Report the actual outcome — including failures and error conditions you *didn't* clear. Surfacing an error
honestly > burying it.

**5. Self-check before you claim done.** Run `git diff --stat`. Confirm **every** changed file is in your task's
scope. If one isn't, **revert it** and report why you thought you needed it. Then re-read your claim: does it
say "passed" about anything you didn't actually run? Fix that.

**6. Declare understanding & scope BEFORE you touch anything.** Before writing any code, state **in your own
words**: (a) the **scope** — which files/behaviour you may touch and which you may **NOT**; (b) what **"done"**
looks like; (c) the **approach** you'll try first. A wrong scope statement gets corrected *before* work, not
after.

**7. Pre-register a retry budget PER TEST — and when you stop, actually STOP.** The budget is **per individual
test/verify cycle — NOT one number for the whole task.** Lock the number before you see the result. Count out
loud. On the final attempt say so, and if it fails, **STOP and report. STOP MEANS STOP:** end your turn and do
**not** keep working, exploring, or "trying one more thing." **Declaring a stop and then continuing is itself a
violation.** **STOP at the EARLIER of:** the show-stopper fence (Rule 2 — even on attempt 1), **or** that test's
budget.

**The gold-standard response when blocked** (imitate this):
> ✅ *"I did the in-scope change. The live test then exposed a **pre-existing race** in the bridge. That's out of
> my scope. **I did NOT modify it.** STOPPING and reporting; this needs a scope decision."*
>
> ❌ *(forbidden)* "I patched the bridge to ignore the late message so the test would pass."

---

## Working discipline in this repo

- **Code changes happen in a per-task git worktree and on a task branch — never directly in the primary
  checkout.** Documentation may be edited directly. This is the containment model: your changes stay on your
  branch until a human lands them.
- **Merging and pushing are the Product Owner's acts, never yours.** Commit your work, report, and stop. Do not
  merge to `master`, do not push, and do not delete or rewrite branches you did not create.
- **Do not resync `package-lock.json`.** It has a known committed drift against `package.json`, tracked in the
  AgentTalk backlog as BL-100 and reserved to the PO. An `npm install` will dirty it; leave that change out of
  your commits.
- **Vocabulary: say "launch", never "spawn."** This is a hard naming convention across the whole project — in
  code, comments, commit messages and reports alike. Correct it when you see it.

---

## What this file deliberately does NOT carry — and why

This repo has no epics, no ledger and no review gates of its own; those live in AgentTalk. The following are
**intentionally absent, and should not be added here:**

| Absent | Why |
|---|---|
| **The session-primer handshake, key stores, role primers** | **Deliberate and load-bearing.** A worker launched here is *exempt from the primer gate* by an already-merged decision. Instructions to "handshake and STOP" would halt every launched worker before it did any work. **Do not import them.** |
| Role assignments, reviewer seats, Scrum Master / Architect charters | No gates are convened in this repo; the seats live in AgentTalk. |
| Milestone history, epic ledgers, backlog protocol | Not this repo's artifacts. |
| Origin tag protocol | No baton is routed here. |
| Resource-telemetry closure blocks | Closure telemetry attaches to an AgentTalk ledger entry. |

Their absence means this file is **scoped**, not incomplete.

---

## Further context — *pointer only, NOT authority*

Deeper method and history live in the sibling **AgentTalk** repo: `design/collaboration-workflow.md` (the
method), `design/backlog.md` (items and decisions), `AGENT.md` (the full governance file).

**Everything above binds whether or not you can reach that repo.** The path is usually a sibling of this
checkout, but from a task worktree it resolves somewhere else entirely and may simply not exist. **If you cannot
find it, you are still fully governed by this file** — it is complete on its own, and no rule here depends on
reading anything elsewhere.
