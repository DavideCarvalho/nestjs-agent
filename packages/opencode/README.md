# @dudousxd/nestjs-agent-opencode

Run `@dudousxd/nestjs-agent` turns on [OpenCode 2](https://opencode.ai). The library keeps the
routes, threads, stream protocol, approvals, questions and queue (so `@dudousxd/nestjs-agent-react`
works unchanged); OpenCode runs the model, the tools, skills and the context.

```ts
import { AgentModule } from '@dudousxd/nestjs-agent';
import { openCode, type OpenCodeHost } from '@dudousxd/nestjs-agent-opencode';

@Injectable()
class MyOpenCodeHost implements OpenCodeHost {
  constructor(private readonly sandboxes: SandboxService) {}

  /** Which OpenCode server runs this actor's turns. */
  async server(actor: Actor) {
    const rt = await this.sandboxes.runtimeFor(actor.tenantId);
    return { client: rt.client, key: actor.tenantId, bootId: rt.bootId };
  }

  /** How a thread's session is created (only when it has none on this server). */
  async session({ input }: OpenCodeTurnContext) {
    return {
      location: { directory: `/work/${input.actor.id}` },
      permissions: [
        { action: '*', resource: '*', effect: 'deny' },
        { action: 'execute', resource: '*', effect: 'allow' },
        { action: 'company.*send*', resource: '*', effect: 'ask' }, // → approval card
        { action: 'question', resource: '*', effect: 'allow' },     // → elicitation form
      ],
    };
  }

  /** Extra instructions entries, refreshed every turn. */
  async instructions({ input }: OpenCodeTurnContext) {
    return { 'app.profile': await this.profiles.describe(input.actor) };
  }
}

@Module({
  imports: [
    AgentModule.forRoot({
      engine: openCode({ host: MyOpenCodeHost }),
      store, // any AgentStore
      actorResolver,
    }),
  ],
  providers: [MyAgent], // @Agent({ systemPrompt }) / @SystemPrompt() → instructions `aviary.system`
})
export class AppModule {}
```

| OpenCode | The library's protocol and store |
| --- | --- |
| `session.text.delta` / `session.reasoning.delta` | `text` / `reasoning` |
| a step (`session.step.ended`) | `step-start` … `step-finish` with usage and cost; a `chat` usage row per step (see [Cost and usage](#cost-and-usage)) |
| the title OpenCode generates, a compaction | a `title` / `history_summary` usage row (see [Cost and usage](#cost-and-usage)) |
| tools (`session.tool.*`) | `tool-input-*` / `tool-output*`, code-mode inner calls nested by `parentId` |
| `permission.asked` | an `action` call + `approval-requested`, recorded `pending_approval`; `approve` / `reject` → `permission.reply` |
| `form.created` | `elicitation`; `answer` / `skip` → `session.form.reply` / `cancel` |
| `session.renamed` | `title` |
| `session.execution.*` | the run settles: queue handoff, `cancelled`, or a typed stream failure |
| `cancel` | `session.interrupt` |

Sessions: one per thread, kept by an `OpenCodeSessionStore` (in memory by default; persist it for
several replicas) and recreated when the server's `bootId` changes, told the conversation so far.

## Cost and usage

Every model call OpenCode makes for a turn — each step, the title it gives the session, a
compaction — goes to the same token-usage ledger the library's own loop writes (`recordUsage`:
`agent_token_usage` with `cost_usd` and `cost_source`), so the ledger quota (`quota: { limits }`),
the dashboard and `GET /quota` see an OpenCode turn like any other.

- **The title and compactions.** OpenCode records those calls on the session without streaming
  them. The turn reads what the session had spent (`session.get`) before it prompts, and when the
  execution ends records what the session spent since that its steps did not report, as a `title`
  row (`history_summary` when a compaction ran). A `session.usage.recorded` event, from an OpenCode
  that streams it, is recorded as it arrives and not counted twice.
- **Tokens.** OpenCode reports the uncached input in `tokens.input` and the cache beside it; the row
  counts the whole input side in `inputTokens`, with `cacheReadTokens` / `cacheWriteTokens` as
  subsets (the library's `MessageUsage`). The row's model is the one OpenCode names for the step
  (`<providerID>/<model id>`, e.g. `amazon-bedrock/us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0`).
- **Cost.** OpenCode prices each call itself, off its model catalog. A call it priced (`cost > 0`) is
  recorded at that figure, `cost_source: 'provider'`. A call it priced at 0 — no price for the model
  in its catalog — is estimated from the library's price for the model, `cost_source: 'estimate'`:
  the pricing store's row, else (seeded into the store once, as at boot) `priceCatalog.prices`, the
  built-in GovCloud Bedrock table (`priceCatalog.region` / `AWS_REGION`, or a `us-gov.` id) and
  models.dev. A model the library cannot price keeps OpenCode's 0.
- `openCode({ cost: 'estimate' })` prefers the library's price whenever it has one — for models
  OpenCode would price at a list price that is not yours (models.dev lists commercial Bedrock prices,
  so Bedrock in GovCloud is priced too low unless OpenCode's config declares the model's `cost`).
- **The run's total** (`OpenCodeRunResult.usage` for `beforeSettle` / `onSettled`, and the usage on
  the turn's last message) is added up from the turn's own calls, not read back from the store: each
  milestone carries what was spent since the last one, and a durable run journals it with the
  milestone, so a run resumed in another process (an approval answered after a restart) still reports
  the whole run, cache tokens included. A process that dies while OpenCode works does not lose the
  calls it saw: the `observe` re-run reads each step's usage back from the session's messages (see
  below).

## Durable turns

```ts
import { openCodeDurable } from '@dudousxd/nestjs-agent-opencode/durable';

AgentModule.forRoot({ engine: openCodeDurable({ host: MyOpenCodeHost, sessions: MySessionStore }), store, sink, actorResolver })
// next to a configured DurableModule
```

Every step of a turn is checkpointed (`begin → prompt → observe → [wait for a person → reply →
observe]* → finish`) and a person's decision is a durable signal: a turn waiting on an approval
survives restarts and is resumed by whichever process gets the decision. If OpenCode restarted
meanwhile, a new session is opened with the conversation and the decision. If the API restarted
while OpenCode worked (its `observe` step re-runs), the rebuilt turn catches up on what OpenCode
asked meanwhile and, when the execution ends, on what it said: the text, tool calls and results and
each step's usage are read back from the session's messages after the turn's prompt (the prompt
carries the run id in its `metadata`), less what was already taken before the restart (journaled
with each ask). A session that left no answer at all fails the turn (`LOST_ANSWER_ERROR`) instead
of settling it as an empty success. It needs the client's `message.list`. `openCode()` runs the
same steps in memory (single replica). Several processes need a cross-process sink and a persistent
`OpenCodeSessionStore`.

### Limits, stops and lifecycle hooks

Everything here is optional; without these options a turn runs exactly as before. They work with
`openCode()` too.

```ts
openCodeDurable({
  host: MyOpenCodeHost,
  // Per engine, or `(input) => limits` per turn.
  limits: { steps: 40, compactions: 2, wallClockMs: 10 * 60_000 },
  onTurnStart: ({ turnId, threadId, sessionId, resumed }) => turnState.open(turnId),
  onTurnEvent: ({ turnId, type, sessionId }) => turnState.saw(turnId, type),
  onStop: ({ turnId, reason, counts }) => credentials.revoke(turnId),
  onTurnEnd: ({ turnId, status, stop }) => turnState.close(turnId, status, stop?.reason),
});

// A stop the app starts (a revoked credential, a budget it keeps itself):
await app.get(OpenCodeTurns).stopTurn(runId, 'budget');
// → 'aborted' | 'settling' | 'pending' | 'ignored' | 'unconfirmed'
```

| Option | Type | What it does |
| --- | --- | --- |
| `limits.steps` | `number` | Model rounds (`session.step.started`) the turn may run; the next one stops it. |
| `limits.compactions` | `number` | Compactions (`session.compaction.started`) the turn may run; the next one stops it. |
| `limits.wallClockMs` | `number` | Stops the turn this long after its `begin`, time parked on a person included. |
| `onTurnStart` | `({ turnId, threadId, sessionId, resumed }) => void \| Promise<void>` | This process starts executing the turn; `resumed: true` when it took the run over from another (a crash, a run resumed elsewhere after a person answered). |
| `onTurnEvent` | `({ turnId, type, sessionId }) => void` | One OpenCode event of the turn's own session: its type, never its payload. |
| `onStop` | `({ turnId, reason, counts }) => void \| Promise<void>` | A stop landed. `counts` is `{ steps, compactions, elapsedMs }`. |
| `onTurnEnd` | `({ turnId, status, stop? }) => void \| Promise<void>` | This process is done with the turn. `status` is `'succeeded' \| 'failed' \| 'interrupted' \| 'released'`. |
| `hookTimeoutMs` | `number` | How long a step waits for `onTurnStart`. Default 5 seconds; must be positive. |

Limits count what a turn may do: a limit of N allows N steps (or compactions), and the next one
stops the turn. `turnId` is the run id. Only OpenCode's events for the turn's own session count
(another thread's session or a subagent's do not).

**How a stop ends the turn.** A stop aborts the session (`session.interrupt`), so OpenCode starts no
new round. The turn ends `failed` with `outcome.stop = { reason, counts }`, which the host's
`beforeSettle` and `onSettled` see on the `OpenCodeRunResult`. The run row and the stream carry the
error code `opencode_stopped`, and the durable workflow returns `{ outcome: 'failed', stop: reason }`.
`reason` is `'steps' | 'compactions' | 'wall-clock'`, or what the app passed to `stopTurn`. Return
`{ error }` from `beforeSettle` to word the message the person reads. When the answer was already
settling as the stop landed, the answer is kept: the turn ends `succeeded`, with `stop` still set on
the outcome, `onTurnEnd` and the workflow result, and `onStop` still called.

**What a stop aborts.** A thread's session is reused by its next turn. So, immediately before the
abort, the engine checks that the turn is still running here, still owns its session, and is still
the run the thread's store holds. If any check fails, the stop is `'ignored'`. If the store cannot be
read, nothing is aborted and the stop is `'unconfirmed'` (ask again). A stop for a turn that ended
does nothing.

**A stop while the turn waits on a person** returns `'pending'`. The ask it waits on is refused,
whatever the person answers (an approval becomes a rejection, a form is skipped), so no action runs.
The stop then lands as soon as the turn observes OpenCode again. If the OpenCode server restarted
while the turn waited, no new session is opened or prompted: the turn ends stopped. To end a parked run at once, cancel
it.

**Where the hooks run.** The hooks are called in the process that executes the turn's steps. With
`openCodeDurable()` any worker may claim a run, so that is the worker that runs them, not the one
that admitted the question. They can also be set on the host (both are called, the options' first).
Their errors are logged and never fail the turn. Only `onTurnStart` is waited for, at most
`hookTimeoutMs`; the others are called and not waited for.

**`onTurnEnd` is paired with `onTurnStart`.** Every process that gets `onTurnStart` for a turn gets
exactly one `onTurnEnd` for it, and its per-turn state goes with it:

- The turn settled there: `succeeded`, `failed` or `interrupted`.
- It was cancelled from another process while parked there: `interrupted`. The session's execution
  was interrupted under the parked turn, so the store is read again: right away, then at about
  0.25, 1.25, 4.25, 14.25 and 44.25 seconds (one read at a time, at most one every 250 ms). The turn
  is let go when the store shows the ask settled, when the store cannot tell (no `toolCallApproval`,
  a failed read, the ask not on file) after the first recheck, or when the rechecks run out.
- Another worker went on with it after a person answered: `released`. This fires on the next round
  (`session.step.started`), or when an event of the session finds the parked ask decided in the
  store by someone else.
- The process shut down while executing it: `released`.

While a turn is parked here, OpenCode may keep running the step's other tool calls. Their events
are streamed and recorded as usual, and they do not count as the turn moving elsewhere. If the
session's execution ends some other way (succeeded or failed) while the ask is still open, the turn
stays here for its answer, and a stop asked meanwhile returns `'pending'`.

A process that never executed the turn (the API that admitted or cancelled it) gets no hooks.
`stopTurn` acts only in the process executing the turn; anywhere else, and after `onTurnEnd`, it
returns `'ignored'`.

## What the session gets from the module

| Option | In the session |
| --- | --- |
| `@Agent` / `@SystemPrompt` / contributors | instructions `aviary.system`, refreshed every turn |
| `approvalPolicy` | who approves each `permission.asked`, and its expiry; not required → answered at once |
| `tools: { url, secret }` | the module's `@AiTool`s over the engine's own MCP endpoint: reads allowed, actions asked, and run only against an approval |
| `skills` / `@Skill` | `.opencode/skills/<name>/SKILL.md` in the session's directory |
| `memory` | instructions `aviary.memory`; with `tools`, a `remember` tool when the provider writes (on the engine's endpoint only) |
| `ctx.emitUi` in a tool | the component lands in the turn's stream and message (see below) |
| `regenerate` | the session is reverted to before the last user message |

## Tools over MCP

With `tools`, the engine mounts its own MCP endpoint at `POST <agent path>/opencode/mcp` and
registers it in every session (`mcp.add`) with a bearer token it mints: signed with `tools.secret`,
naming the turn's actor and the OpenCode server, expiring after `tools.ttlMs` (7 days; re-issued on a
kept session's turns once half-way through). Use the same `secret` in every process.

```ts
AgentModule.forRoot({
  engine: openCode({
    host: MyOpenCodeHost,
    // Where the OpenCode server reaches this app's endpoint — see "The tools URL" below.
    tools: { url: process.env.OPENCODE_TOOLS_URL!, secret: process.env.OPENCODE_TOOLS_SECRET },
  }),
  memory: { provider }, // a provider with `write` → OpenCode gets `remember`
  ...
}),
```

### The tools URL

`tools.url` has no default and is not derived from anything: the engine passes it verbatim to
OpenCode (`mcp.add` with `{ type: 'remote', url, headers: { Authorization: 'Bearer <token>' } }`),
and it is the **OpenCode server** — a separate process, often in another container or sandbox — that
calls it back. So it must be an address of this Nest app **as seen from the OpenCode server**, ending
in `<path>/opencode/mcp` (`path` is `AgentModule`'s route prefix, `agent` by default; a global prefix
is part of it too). There is no special hostname: `app.internal` in older examples was only a
placeholder. Keep it in an env variable (`OPENCODE_TOOLS_URL`) so each deployment sets its own.

| Where OpenCode runs | `OPENCODE_TOOLS_URL` |
| --- | --- |
| Same machine as the app | `http://127.0.0.1:3000/agent/opencode/mcp` |
| Docker Compose | the app's service name: `http://api:3000/agent/opencode/mcp` |
| Kubernetes | the app's Service DNS: `http://api.my-namespace.svc.cluster.local:3000/agent/opencode/mcp` |
| Anywhere else | the app's public URL works (`https://app.example.com/agent/opencode/mcp`) |

Prefer an internal network address: the endpoint only ever serves OpenCode, and a public URL puts it
on the internet (it stays guarded by the token, below). It must reach a process that mounts
controllers — `surface: 'engine'` mounts none. If several processes sit behind that address (or the
turns run on engine workers and the endpoint on HTTP pods), give them all the same `tools.secret`, so
a token signed by one is accepted by the others; without it each process signs with its own random
secret and the engine logs a warning.

The endpoint serves turns, nothing else. A token alone runs nothing:

- a call runs only while the token's actor has a turn running on the session the call names (OpenCode
  puts it in `_meta`), on the token's server;
- the agent's (and persona's) allow-list, `enabled`, the roles policy and `canUse` apply, on
  `tools/list` and on `tools/call`; the kinds only the loop serves are never offered;
- an `action` runs only against an approval granted in that turn (a person's, or the approval policy
  saying none is needed): one call per approval. OpenCode's `ask` rules put the approval card in
  front of the call; the endpoint checks it again, so a caller that skips OpenCode's rules (a model
  in code mode that read the endpoint's headers) is refused;
- `remember` is served here only — it is not added to the module's registry, so it is not on
  `AgentMcpServerModule` or the `/tools` catalog.

The module's `decorators` are not applied to the endpoint (its callers are OpenCode sessions, not the
app's users); a global guard of your own must let `opencode/mcp` through.

## Several processes

Use `openCodeDurable()`, a cross-process sink, and a shared session store:
`sessions: keyValueOpenCodeSessionStore(redis)`.

## Testing against a real OpenCode

```sh
OPENCODE_LIVE_URL=http://127.0.0.1:4096 OPENCODE_LIVE_PASSWORD=… \
OPENCODE_LIVE_MODEL=opencode-go/longcat-2.5-preview-free OPENCODE_LIVE_DIR=/tmp/work \
pnpm vitest run packages/opencode/src/live
```

The server (`opencode serve`, 2.x, `OPENCODE_SERVER_PASSWORD` set) needs a key for the model's
provider (`integration.connect.key`). Without `OPENCODE_LIVE_URL` the live specs are skipped.

See `docs/design/2026-10-06-opencode-engine.md` for what is not wired yet.
