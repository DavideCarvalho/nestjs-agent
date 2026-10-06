# Engines: running turns on OpenCode

Status: accepted

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

## Durable runs

`openCodeDurable({ host })` (`@dudousxd/nestjs-agent-opencode/durable`) runs each turn as the
`agent.opencode.run` workflow: `begin → prompt → observe:0 → [waitForSignal tool:<run>:<call> →
reply:n → observe:n+1]* → finish`. Both runners drive the same steps (`OpenCodeTurns`), and the turn
(`OpenCodeTurn`) reports milestones instead of waiting on people itself, so:

- a turn parked on a person is a suspended run: an API restart loses nothing, and the decision is
  replied from whichever process takes it (the live turn is rebuilt from the session);
- a process that dies while OpenCode works re-runs that `observe`, which first catches up on the
  permissions and forms OpenCode raised while nobody listened (`permission.list`,
  `session.form.list`); `session.wait` is the safety net for a terminal event that was missed;
- when OpenCode itself restarted while the turn waited, the request is gone: the card settles as
  decided, and a new session is opened with the conversation and the decision, and prompted to go on.

A multi-process deployment needs a cross-process `TokenStreamSink` and a persistent
`OpenCodeSessionStore` (the default keeps sessions in memory).

## The library's seams under OpenCode

| Seam | Under OpenCode |
| --- | --- |
| `@Agent` / `@SystemPrompt` / contributors | instructions entry `aviary.system`, every turn |
| `approvalPolicy` | consulted on every `permission.asked`: not required → answered at once; otherwise its approver and `ttlMs` (expiry → rejected, "nobody approved in time") |
| remembered approvals | answered without asking |
| `@AiTool`s (`tools: { url, headers }`) | served by `AgentMcpServerModule` (`actions: 'execute'`), registered in the session with `mcp.add`; `read` tools allowed, `action` tools `ask` → approval cards |
| `skills` / `@Skill` | written as `.opencode/skills/<name>/SKILL.md` in the session's directory, allowed for the `skill` tool |
| `memory` | instructions entry `aviary.memory` (read-only: OpenCode has no `remember`) |
| regenerate | the store is rewound and the session reverted (`session.revert`) |

## What an engine does not get

Everything that lives inside the loop: input/output processors, `outputSchema`, `maxSteps`,
`history` windows, inject-mode `retrieval`, delegation (`handoff`), the loop's own tool execution.
Under OpenCode these are OpenCode's (permission rules, its agents and subagents, compaction), or the
host's gateway's.

## Not yet

- **Writing memory.** The `remember` tool is the loop's; under OpenCode the block is read-only.
- **Generative UI pushed by tools** (`ui` frames): arrives through the host today (Flippy's `ui` MCP
  server pushes components out of band).
- **A real OpenCode server.** Event and call shapes follow Flippy's production use of OpenCode 2;
  the specs run against `testing/fake-opencode.ts`.

## Consequences

Flippy can replace `apps/api/src/chat/{event-hub,turn.workflow}.ts`, the event switch of
`turns.service.ts` and `apps/api/src/agent/*` with `openCodeDurable({ host: FlippyOpenCodeHost })`.
Other hosts get OpenCode behind the library's routes and React hooks with one class.
