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
  the whole run, cache tokens included. A process that dies while OpenCode works loses the calls it
  saw from that total (their ledger rows are already written).

## Durable turns

```ts
import { openCodeDurable } from '@dudousxd/nestjs-agent-opencode/durable';

AgentModule.forRoot({ engine: openCodeDurable({ host: MyOpenCodeHost, sessions: MySessionStore }), store, sink, actorResolver })
// next to a configured DurableModule
```

Every step of a turn is checkpointed (`begin → prompt → observe → [wait for a person → reply →
observe]* → finish`) and a person's decision is a durable signal: a turn waiting on an approval
survives restarts and is resumed by whichever process gets the decision. If OpenCode restarted
meanwhile, a new session is opened with the conversation and the decision. `openCode()` runs the
same steps in memory (single replica). Several processes need a cross-process sink and a persistent
`OpenCodeSessionStore`.

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

The module's `guards` are not applied to the endpoint (its callers are OpenCode sessions, not the
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
