# Engines: running turns on OpenCode

Status: accepted (v1 shipped in `@dudousxd/nestjs-agent-opencode`)

## Context

Flippy runs its chat on OpenCode 2 (one `opencode serve` per tenant, in a sandbox) and serves it to
the browser through this library's protocol (`/agent` routes, `@dudousxd/nestjs-agent-react`). To do
that it hand-wrote ~2k lines: an event hub over OpenCode's event stream, a translator from
OpenCode events to `AgentStreamEvent` frames, a turn workflow that parks on approvals and questions
and replies to OpenCode, and controllers mirroring the library's routes. None of it is Flippy
specific, and any other host that wants OpenCode behind the library would write it again.

The library's `AgentRunner` SPI (`start` / `signal` / `cancel` / `isRunActive`) is already the seam
between the routes and whatever runs a turn. A `ModelProvider` is not: it is one model call inside
the library's loop, and OpenCode has a loop of its own (tools, permissions, skills, compaction).

## Decision

1. **`engine` on `AgentModule`** (`AgentEngine`: `{ name, providers, runner }`). An engine brings its
   providers and binds `AGENT_RUNNER` to its runner. `model` becomes optional when an engine is set;
   `engine` + `durable: true` is refused at boot (the durable runner is the loop's). Static wiring,
   like `durable` and `adapters`, so it lives on `forRootAsync`'s options too.
2. **`openCode({ host })`** in a new package, `@dudousxd/nestjs-agent-opencode`:
   - `OpenCodeHost` is the only thing a host writes: which server a turn runs on (`server`, with a
     `bootId` so sessions lost in a restart are recreated), how a session is created (`session`:
     location, model, OpenCode agent, permission rules), instructions refreshed every turn,
     `prepare` for new sessions (MCP servers, skill files) and `files` for attachments.
   - `OpenCodeAgentRunner` keeps one session per thread (`OpenCodeSessionStore`, in memory by
     default), persists the user message, puts the agent's prompt (`@Agent` / `@SystemPrompt` + the
     contributors) under `aviary.system`, prompts, and settles the run like `InlineAgentRunner`
     (queue handoff, thread release, run row, `cancelled` frame, typed failure).
   - `OpenCodeTurn` maps OpenCode events to the native protocol and the store: steps with usage,
     text, reasoning, tools (code-mode inner calls nested by `parentId`), `permission.asked` →
     an `action` call with `approval-requested` recorded `pending_approval` (so `approve` / `reject`
     find the run), `form.created` → `elicitation` (answers typed back into the form reply),
     `session.renamed` → `title`. Remembered approvals are answered without asking.
   - The OpenCode client is structural (`OpenCodeClient`): no runtime dependency on
     `@opencode/client`, and a fake (`testing/fake-opencode.ts`) drives the specs.
3. **The native protocol only.** The engine writes `AgentStreamEvent` frames; AG-UI stays an
   optional adapter over the same runs.

## What an engine does not get

Everything that lives inside the loop: input/output processors, `outputSchema`, `maxSteps`,
`history` windows, inject-mode `retrieval`, delegation (`handoff`), the loop's own tool execution
and governance gate per call. Under OpenCode these are OpenCode's (permission rules, its agents and
subagents, compaction), or the host's gateway's.

## Not yet (follow-ups)

- **Durable runs.** v1 parks a run on a person in process memory (single replica, like the inline
  runner). Flippy's `TurnWorkflow` shape is the template: `prompt → observe → [waitForSignal →
  reply → observe]* → finish` as a `@dudousxd/nestjs-durable` workflow, re-prompting a fresh session
  with the decision when the server restarted while waiting.
- **`@AiTool` over MCP.** Serve the module's tools to the session through `mcp-server` and register
  them in `prepare`, with `kind: 'action'` tools turned into `ask` permission rules.
- **Skills and memory** from the library's seams written into the session (skill files, a memory
  entry and a `remember` tool).
- **Approval policy.** `approver` is a fixed string; `ApprovalPolicy` (approver per tool, expiry) is
  not consulted yet.
- **Generative UI pushed by tools** (`ui` frames) arrives through the host today (Flippy's `ui` MCP
  server pushes components out of band).
- Regenerate rewinds the store but not the OpenCode session (Flippy uses `session.revert`).

## Consequences

Flippy can replace `apps/api/src/chat/{event-hub,turn.workflow}.ts`, the event switch of
`turns.service.ts` and `apps/api/src/agent/*` with `openCode({ host: FlippyOpenCodeHost })` once the
durable runner lands; until then it keeps its own workflow. Other hosts get OpenCode behind the
library's routes and React hooks with one class.
