<p align="center">
  <a href="https://davidecarvalho.github.io/aviary/docs/agent">
    <img src="./.github/banner.svg" alt="@dudousxd/nestjs-agent — an Aviary library. Call sign: Magpie.">
  </a>
</p>

<p align="center">
  <b><a href="https://davidecarvalho.github.io/aviary/docs/agent">📖 Read the documentation</a></b>
  &nbsp;·&nbsp; part of the <a href="https://davidecarvalho.github.io/aviary/"><b>Aviary</b></a> ecosystem for NestJS
</p>

---

# `@dudousxd/nestjs-agent`

[![CI](https://github.com/DavideCarvalho/nestjs-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/DavideCarvalho/nestjs-agent/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@dudousxd/nestjs-agent.svg)](https://www.npmjs.com/package/@dudousxd/nestjs-agent)
[![npm downloads](https://img.shields.io/npm/dm/@dudousxd/nestjs-agent.svg)](https://www.npmjs.com/package/@dudousxd/nestjs-agent)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/DavideCarvalho/nestjs-agent/blob/master/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9+-blue.svg)](https://www.typescriptlang.org/)
[![NestJS](https://img.shields.io/badge/NestJS-10%2B-e0234e.svg)](https://nestjs.com/)

A **governed, durable-backed AI agent** for NestJS — the Laravel feel for building an in-app AI
assistant. Chat + tool-calling + role/persona governance + token quota + cost tracking +
human-in-the-loop approval + resumable streaming + **multi-agent delegation**, out of the box.

The agent turn runs as a **durable workflow** (replay-safe, resumable, HITL via signals) — or
in-process when you don't need durability. The **mechanism** is the library; your **domain**
(which tables, which tenant column, which roles/abilities) is policy you supply.

Extracted and generalized from the flip-nestjs admin assistant.

## Packages

| Package | What it is |
|---|---|
| `@dudousxd/nestjs-agent-core` | Framework-agnostic SPIs, tool registry, the agent loop, personas, and the `aviary:agent:*` diagnostics channel |
| `@dudousxd/nestjs-agent` | The NestJS module: `@AiTool` + discovery, `/agent/*` SSE controllers, inline + durable runners, multi-agent `forFeature` |
| `@dudousxd/nestjs-agent-store-mikro-orm` | MikroORM persistence (threads, messages, tool calls, usage, pricing) |
| `@dudousxd/nestjs-agent-store-drizzle` | Drizzle persistence — the same `AgentStore` on a second ORM (SQLite/Postgres) |
| `@dudousxd/nestjs-agent-authz` | Plug `@dudousxd/nestjs-authz` into tool authorization (a tool's `ability` → a `Gate` check) |
| `@dudousxd/nestjs-agent-data` | Governed read-only SQL tool (single-SELECT AST validation, fail-closed table access, tenant scoping) |
| `@dudousxd/nestjs-agent-mcp` | MCP client — import an external Model Context Protocol server's tools as governed agent tools (stdio + streamable HTTP), HITL-gated by default |
| `@dudousxd/nestjs-agent-mcp-server` | MCP server — expose this deployment's tools to an external Model Context Protocol client, under the same registry and roles policy a turn runs through |
| `@dudousxd/nestjs-agent-react` | `useAgentChat` + `AgentChatTransport` (Vercel AI SDK v7) + `useChatTranscript` (the headless transcript model) + styling-agnostic chat components; optional `/markdown` subpath |
| `@dudousxd/nestjs-agent-codegen` | A `@dudousxd/nestjs-codegen` extension emitting the `/agent` REST routes into your typed client |
| `@dudousxd/nestjs-agent-telescope` | An "Agent" dashboard tab for `@dudousxd/nestjs-telescope` |
| `@dudousxd/nestjs-agent-dashboard` | A standalone, mountable AI-gateway governance console (bundled React SPA + NestJS module) — no Telescope required |
| `@dudousxd/nestjs-agent-evals` | Answer-quality scoring over stored runs — a `Scorer` SPI, a resumable batch runner, and built-in rule / statistical / model-graded scorers (incl. mining HITL rejections) |
| `@dudousxd/nestjs-agent-testing` | In-memory store/sink + a deterministic fake model for offline tests/demos |

## Install

```bash
pnpm add @dudousxd/nestjs-agent @dudousxd/nestjs-agent-core
# persistence + (optional) durable runner:
pnpm add @dudousxd/nestjs-agent-store-mikro-orm @dudousxd/nestjs-durable
```

## Quickstart

Register the module, then declare tools as ordinary injectables with `@AiTool`.

```ts
import { AgentModule, HeaderActorResolver } from '@dudousxd/nestjs-agent';

@Module({
  imports: [
    AgentModule.forRoot({
      // --- infrastructure ---
      model: myModelProvider,          // a Vercel AI SDK wrapper (ModelProvider SPI)
      store: myAgentStore,             // e.g. the MikroORM store
      defaultRoles: ['ADMIN'],         // roles a tool requires when its own `roles` is omitted
      actorResolver: new HeaderActorResolver(), // who's calling — see "Identity" below
      // path: 'agent',                // route prefix (default 'agent')
      // durable: true,                // run each turn as the durable `agent.run` workflow
      // --- the default agent (optional) ---
      defaultAgent: {
        systemPrompt: 'You are a helpful ops assistant.',
        // modelId: 'claude-sonnet-4-6', // optional accounting label; the provider can report its own
      },
    }),
  ],
  providers: [GetWeatherTool, PurgeCacheTool],
})
export class AppModule {}
```

```ts
import { AiTool, type ToolHandler, type AiToolCtx } from '@dudousxd/nestjs-agent';
import { z } from 'zod';

@AiTool({
  name: 'getWeather',
  kind: 'read',                        // 'read' auto-executes; 'action' requires HITL approval
  description: 'Current weather for a city.',
  input: z.object({ city: z.string() }),
})
export class GetWeatherTool implements ToolHandler<{ city: string }> {
  async execute(input: { city: string }, ctx: AiToolCtx) {
    return { tempC: 21, summary: 'partly cloudy' };
  }
}
```

The module mounts SSE + REST endpoints under `/agent` (configurable via `path`):

| Method & path | Purpose |
|---|---|
| `POST /agent/chat` | Start a turn; streams tokens as SSE (`event: meta` → `data:{delta}` → `event: done`) |
| `GET /agent/chat/:runId/stream` | Resume an in-flight run's stream |
| `POST /agent/chat/:runId/cancel` | Cancel a run |
| `POST /agent/tool-call/approve` · `/reject` | Human-in-the-loop decision for an `action` tool |
| `GET /agent/threads` · `/:id` · `DELETE /:id` · `POST /:id/fork-from/:messageId` | Thread history |
| `GET /agent/threads/personas/catalog` · `GET /agent/quota/today` | Personas & quota |

### Identity (`ActorResolver`)

The agent never invents a caller. Every request's actor — `{ id, roles?, tenantRef? }` — comes
from an `ActorResolver` you configure; tool authorization is a set-intersection of the actor's
`roles` against each tool's. There's **no insecure default**: omit `actorResolver` and every request
throws until you wire one. The shipped `HeaderActorResolver` reads `x-actor-id` /
`x-actor-role` (comma-separated → `roles`) / `x-tenant-ref` and is only safe behind a trusted gateway
that strips and re-sets those headers; production apps typically implement `ActorResolver` over a
verified session/JWT instead.

### Human-in-the-loop & durability

A `kind: 'action'` tool never auto-executes — the loop pauses for an approve/reject decision.
With `durable: true` (plus `AgentDurableModule` and a configured `DurableModule`), that pause is a
real durable suspend: the run is checkpointed to the state store on `ctx.waitForSignal` and resumes
on approval — surviving restarts, replay-safe. Without durable, an in-process runner holds the turn
open. Either way the wire protocol is identical.

### Transient tool errors

A tool call gets **no durable step retries** by default — a bare `@Step()`, since a tool may not be
idempotent. But when a tool's own invocation throws a *classified-transient* error — a DB deadlock,
a lock-wait timeout, a serialization failure — the server already rolled that work back, so
re-invoking it is safe. `toolTransientRetry` retries exactly that class, in place: same tool-call
step, no new checkpoint, in both the in-process loop and the durable-dispatched path
(`AgentRunSteps.tool`).

```ts
AgentModule.forRoot({
  // …
  toolTransientRetry: { attempts: 3, backoffMs: 200 }, // widen the window (default: { attempts: 2, backoffMs: 150 })
  // toolTransientRetry: { classify: (error) => isTransientToolError(error) || isMyDriversTimeout(error) },
  // toolTransientRetry: false, // disable entirely — a tool's own error always surfaces immediately
});
```

- **Default ON**: `{ attempts: 2, backoffMs: 150 }` (total attempts, including the first try; the
  wait before attempt N+1 is `backoffMs * N`), classified by the built-in `isTransientToolError` —
  MySQL (`ER_LOCK_DEADLOCK` / `ER_LOCK_WAIT_TIMEOUT`, codes `1213`/`1205`), Postgres (SQLSTATE
  `40001`/`40P01`), `SQLITE_BUSY`, or a matching `deadlock|lock wait timeout|serialization failure`
  message — checked on the error and one level of `cause`.
- **Widen or narrow** with `classify: (error) => boolean` to recognize another driver's shape, or to
  stop retrying a class the default would otherwise catch.
- **Disable** entirely with `toolTransientRetry: false`.
- **Non-goal**: a tool's other (non-transient) failures are unaffected — they remain a one-shot
  business outcome recorded as `status: 'failed'`, exactly as before. This is retry for a rolled-back
  side effect, not a general reliability net for tools that fail for ordinary reasons.

Each retry emits an `aviary:agent:tool.retry` point event (`{ toolName, toolCallId, attempt,
message }`) — see [Observability](#observability-diagnostics) below.

### Several tool calls in one turn

A model routinely asks for more than one tool at a time. When **every** call in the turn is a
`read`, their invocations run concurrently — the turn costs its slowest call rather than the sum of
them. Nothing to configure; both runners do it.

Only the invocations overlap. The turn's bookkeeping stays strictly in call order — every call is
claimed first, then the batch is launched in one tick, then the results are recorded — because under
`durable: true` the loop body is *replayed*, and checkpoint positions are handed out as the body
runs. Ordering them by whichever tool finished first would give the replay a different journal than
the original run. (Worse, under dispatched steps every tool call checkpoints under the same routing
name, so a swapped pair raises no error at all — it hands one call's output to another.)

A turn is eligible only when every call is a `read`. An `action` waits on a human, which is decision
time rather than I/O, and reserving an execution slot for a call that may still be rejected reserves
one the rejection never fills; an `agent` delegation is a child workflow, whose parallel form is the
durable runtime's own `ctx.all`. Those turns run one call at a time, exactly as before.

## Conversation history

A turn carries the whole thread by default: every message the store holds, on every turn. That is
fine for a support chat and wrong for an assistant someone lives in — the prompt grows, each turn
costs more than the last, and eventually the provider rejects the request outright. `history` puts a
ceiling on it.

```ts
AgentModule.forRoot({
  // …
  history: { maxMessages: 40, maxTokens: 60_000, summarize: true },
});
```

- **`maxMessages` / `maxTokens`** keep the newest messages that fit; set both and whichever cuts more
  wins. Tokens are estimated (~4 chars/token plus tool-call payloads) — a real tokenizer is
  model-specific, and a budget only has to keep you clear of the hard limit. The newest message always
  rides, whatever the limits say.
- **`summarize: true`** folds what the window left out into a leading `system` summary instead of
  simply losing it. It costs one extra model call per run, recorded as a `history_summary` usage row
  so it shows up in spend like anything else.
- **Per agent**: `@Agent({ history: { maxMessages: 8 } })` overrides the module-wide ceiling — a
  persona that answers from a page context needs far less window than one reasoning over a long
  back-and-forth.
- **Your own rule**: `historyPolicy` takes a `HistoryPolicy` for a window the built-in can't express
  (pin the thread's opening brief, keep every message carrying a tool result, vary the budget by
  actor). `select` must be a pure function of the messages it's given; anything that calls out —
  including summarizing — belongs in `summarize`, which the loop runs inside a checkpoint so a
  resumed durable run reads the summary back rather than producing a different one.

Configure none of it and nothing changes, including the loop's durable checkpoint names and
positions — a run already in flight keeps replaying.

## Input and output processors

`history` decides *which* messages reach the model. Processors decide *what they say* — and, on the
way back, whether the answer is allowed out at all.

```ts
AgentModule.forRoot({
  // …
  inputProcessors: [maskIdentifiers],
  outputProcessors: [refuseRawCustomerRows],
});
```

- **`InputProcessor.process({ system, messages }, ctx)`** returns the prompt rewritten. It runs
  before **every** model call of a turn, not once per run: the transcript grows between steps, so a
  redactor that only saw the opening prompt would wave through whatever a tool result carried back.
  The loop's own transcript is untouched — a redaction is what leaves the process, never the thread's
  memory of what was said.
- **`OutputProcessor.process({ text, toolCalls }, ctx)`** returns `{ action: 'pass' }`,
  `{ action: 'replace', text }` (a redaction is a replacement), or `{ action: 'reject', reason }`,
  which ends the run with an `OutputRejectedError` and an `output_rejected` stream error instead of an
  answer. Chained in order, each seeing what the previous one produced; the first rejection stops the
  chain.
- Both run inside a durable checkpoint, so a processor may call a model (a moderation pass is the
  point) and a resumed run reads the verdict back rather than deciding it again. One that throws
  surfaces as `ProcessorFailedError` naming the phase and the processor, so it can't be mistaken for
  the model failing.
- They are module-wide and apply to every agent. A control one persona can turn off is not a control.

**Registering an output processor turns off live token streaming for that turn.** A gate that has to
read the whole answer cannot run after the answer has already reached the reader, so the model call
writes to a buffer and the loop releases it as one `text` frame once the chain passes. Step
boundaries and the turn's tool-call frames still arrive live; token-by-token text does not. That is
the price of a gate that gates — and it holds under `dispatchedSteps: true` too, where the model runs
on another worker and hands its held frames back on the step result.

Register neither and nothing changes, checkpoint names and positions included.

## Structured output

```ts
const Report = z.object({ headline: z.string(), rows: z.number() });

@Agent({ name: 'analyst', systemPrompt: '…', outputSchema: Report })
export class AnalystAgent {}
```

The validated value comes back as `object` on the run's result and is delivered the way any tool call
is — on the assistant message's `toolCalls`/`toolResults` as a synthetic `structured_output` call, as
an `agent_tool_call` row, and live on the stream as a `tool-input-available` + `tool-output` pair — so
a thread reader and the existing tool-output rendering both get it, live and on reload, with no store
change. Any [Standard Schema](https://standardschema.dev) works.

**With tool calling, it is a final formatting pass.** The turn calls its tools exactly as it would
without a schema; once a step comes back with no tool calls, one extra non-streamed call carrying the
schema and **no** tools restates that answer. Most providers refuse a response format and a tool set
in the same request, and the pass is unconditional rather than skipped for a tool-less agent — that
decision would depend on the tool registry of whichever process is replaying the turn. It costs one
model call, billed as a `structured_output` usage row.

A reply that fails the schema is retried with its validation issues attached, `outputRepairAttempts`
times (default 1). After that the run fails with a `StructuredOutputError` carrying the issues, the
offending text and the attempt count, under a `structured_output_invalid` stream error code.

Declared on the agent rather than per request: a schema is a live object, and `AgentRunInput` crosses
a JSON boundary on its way into a durable workflow. A consumer calling `runAgentLoop` directly passes
`outputSchema` per call and gets `object` typed from it.

## Asking the user (intake + `ask`)

Approval settles work the agent has already proposed. This is the other direction — collecting the
scope *before* the work starts.

```ts
@Agent({
  name: 'refactorer',
  systemPrompt: '…',
  intake: {
    preamble: 'Three questions before I start. I have pre-picked what I would choose, so confirming is enough.',
    questions: [
      {
        id: 'scope',
        prompt: 'How much should I cover?',
        options: [
          { value: 'file', label: 'This file', hotkey: 'a' },
          { value: 'module', label: 'The whole module', hotkey: 'b' },
        ],
        defaults: ['module'],
      },
    ],
  },
})
export class RefactorerAgent {}
```

Two surfaces, one shape:

- **A configured intake** runs before the turn's first model call. The questions are authored, so it
  costs **no model call** and `questions.length` is known before the form appears — which is what
  lets a client render "Question 1 of 3".
- **`ask`**, the model-callable tool (`forRoot({ ask: true })`, or `@Agent({ ask })`), for when the
  model itself judges the scope is missing. Its schema *requires* a pre-picked `defaults` on every
  question, so "I would choose X" is mandatory rather than aspirational.

Both persist as the same pending tool-call row, park on the same `tool:<runId>:<callId>` signal a
HITL approval uses, and stream the same `elicitation` frame. A consumer cannot tell which one asked.

Answer with `POST /agent/tool-call/answer` (`{ toolCallId, answers? }`) or decline with
`POST /agent/tool-call/skip` — same ownership check as approve/reject. **An omitted question takes
its own pre-picked default**, resolved server-side from the request, so submitting an empty body is a
valid confirmation. A skip lands on the same values but persists as a *rejection*: proceeding on an
assumption the user refused to confirm is not the same fact as proceeding on one they chose.

Nobody answers → the run stays parked, indefinitely, exactly as an approval does. It is a durable
suspend, not a held socket.

Declare neither and nothing changes: no new checkpoint, no new tool, no change to the sequence.

## Skills (scoped, loaded on demand)

Instructions that are true *sometimes* — how one warehouse labels a pallet, what counts as an
expedited order — have nowhere good to live. In the system prompt they are paid for on every turn by
every user; hardcoded as a tool they are a deploy away from changing. A **skill** splits the two
halves: the prompt carries a one-line-each catalog, and the body is read on demand through a built-in
`skill` tool, arriving as an ordinary tool result.

```ts
AgentModule.forRoot({ /* … */ skills: {} });

@Skill({
  name: 'label-pallet',
  description: 'Label a pallet for outbound freight.',
  scope: 'tenant:berlin',
})
@Injectable()
export class LabelPalletSkill implements SkillBody {
  constructor(private readonly manifests: ManifestService) {}
  body(ctx: SkillContext): string {
    return `Strip any carrier prefix, then match against the manifest…`;
  }
}
```

**A skill is not an agent.** An `@Agent` is *who is answering*; a skill is *how one task is done*, and
any agent may load it. An instruction that applies to every turn of a persona is still that persona's
`systemPrompt`.

**Scoping is an opaque token you order.** A skill is published at `actor:u1`, `tenant:berlin`,
`global` — or your own `depot:north`. Which tokens apply is a `ScopeResolver` returning them
most-specific-first, so precedence falls out of the order and a new axis is a resolver you write
rather than an enum you wait for. Omit it and you get the actor's own scope, their tenant's, and
`global`. **This library owns no skill table**: rows a person administers live behind your own
`SkillProvider` (`list(scopes, ctx)` for the catalog, `load(name, scope, ctx)` for one body), so your
own entities relate to them however they like and your migrations never meet the `agent_*` schema
heal.

Most specific wins, and the entry records what it **shadowed**, so the agent can say "I followed your
depot's version, which differs from the tenant default" instead of choosing silently.

```http
GET /agent/skills → [{ name, description, scope, shadows? }]
```

The same list the model is offered, from the same call — so a `/`-autocomplete can never offer a skill
the agent has never heard of. There is no write endpoint: `skillWriteVerdict` is the rule for your own
console — your own scope is yours, a wider one needs an elevated **human**, and nothing but a human
may ever write above its own scope.

One new checkpoint (`skills:catalog`) holds the whole offer; a load rides a plain read tool's
positions and returns the body *from* the checkpoint, so a skill edited mid-run never rewrites the
prompt of a run in flight, and the journaled catalog — not the provider — decides what a turn may
reach. Declare none and the turn's sequence is byte-identical.

## Memory (what it knows about you)

Everything the agent works out about a person dies at the end of the turn. **Memory** is the bounded
set of conclusions that survives it — a keyed fact at a scope, one line in the system block, written
by the model and deletable by the person it is about.

```ts
AgentModule.forRoot({ /* … */ memory: { provider: myMemoryProvider } });
```

```ts
// MemoryProvider — your rows, your table. `forget` is required; `write` is what decides
// whether the model is offered the built-in `remember` tool at all.
{
  list: ({ scopes }) => this.repo.find({ scope: { $in: [...scopes] } }),
  forget: ({ id }) => this.repo.nativeDelete({ id }).then((n) => n > 0),
  write: ({ key, text, scope, origin }) => this.repo.upsert({ key, text, scope, origin }),
}
```

```text
<memory>
What you concluded about this user and their organisation on earlier turns. These are your own
notes, not documents anyone wrote: they may be wrong or out of date…
- [actor:u1] fiscal-year: they report on the calendar year
    ↳ [global] instead has: the fiscal year starts in October
- [global] units: report distances in nautical miles
</memory>
```

**It is not RAG.** Retrieval answers *what do the documents say*, and cites them. Memory answers
*what did I decide about you*, and has no source to go and fix. So every record carries an **origin**
(which conversation, which run, agent or person), the block tells the model these are its own
fallible notes, and `MemoryProvider.forget` is required rather than optional — a deployment may
serve memory read-only, but none may hold conclusions about someone the someone cannot delete.

**Scoping is the same token, resolved by the same `ScopeResolver` as [skills](#skills-scoped-loaded-on-demand)** —
`actor:u1`, `depot:north`, `tenant:berlin`, `global`, most specific first. Where a narrower
scope wins a key, the entry carries the beaten **value**, not just its scope, so the agent can say
*"your setting differs from the org default"* rather than quietly picking one.

**An agent proposes; a person publishes.** The `remember` tool has **no scope parameter** — an agent
may only ever write the actor it is running for, so there is no request `memoryWriteVerdict`'s third
rule has to refuse. Promoting a fact to a tenant or a sector is a human act in your own console
(`memoryWriteVerdict({ …, author: { kind: 'human' }, elevated })`). A tenant memory an agent could
write is a fact everyone in the tenant is then answered from, with no document to inspect and nobody
aware it was written.

```http
GET    /agent/memories        → [{ id, key, text, scope, origin, updatedAt, overrides? }]
DELETE /agent/memories/:id    → { forgotten: true }
```

The read-back deliberately **ignores `maxMemories`**: that ceiling is a budget on what a *turn*
carries, and applying it here would hide a belief the assistant is one write away from acting on
again. `DELETE` covers the actor's own scope; an id they cannot see answers 404 rather than 403, so
it cannot be used to discover what the assistant believes about other people. A memory whose source
conversation was later truncated away is **kept**, shown with an origin that no longer resolves — a
history ceiling is a cost control and must never double as an eraser.

**Working memory and recall are two features; this is the first.** Searching what was *said* earlier
is retrieval over a transcript — `Retriever`/`Reranker` already do that. The ceiling here is exactly
what makes semantic search over memory pointless: it is a search for something already in the prompt.

**Budget.** `maxMemories` lines (default 20), each capped at `maxFactChars` (default 240) *when
written*, so the block's ceiling is a product an operator can do — and the push-back lands while the
model is writing an essay instead of a fact. One checkpoint (`memory:digest`) holds the whole digest:
it is what the block is rendered from *and* what a `remember` call is authorized against, so a replay
on a pod that resolves the actor differently rebuilds the identical prompt. The write happens inside
the call's own `tool:` checkpoint, so a resume stores nothing twice. `aviary:agent:memory.resolved`
and `aviary:agent:memory.written` report what it cost and how much the agent is writing. Configure
none and the turn's sequence is byte-identical.

## Multi-agent (orchestrator → sub-agents)

Register named agents with `forFeature`; declare which agents an orchestrator may call via
`delegatesTo`. The library synthesizes an `ask_<name>` tool for each edge; when the model calls it,
the loop runs the sub-agent — a **durable child run** under `durable: true`, a nested in-process
loop otherwise. Each delegation is also an `aviary:agent:delegated` event.

```ts
AgentModule.forFeature([
  {
    name: 'ops-orchestrator',
    systemPrompt: 'You coordinate specialists. Delegate weather questions to weather-analyst.',
    delegatesTo: ['weather-analyst'],
  },
  { name: 'weather-analyst', systemPrompt: 'You answer weather questions.', tools: ['getWeather'] },
]);
```

Target an agent per request with `{ "agent": "ops-orchestrator" }` in the chat body. Each agent
gets its own system prompt, model, and tool allow-list (intersected with the persona's).

## Authorization

A tool declares **one** of two gates — `roles` or `ability`:

- **`roles`** (built-in policy): `@AiTool({ roles: ['ADMIN'] })` — the actor passes if any of its
  `roles` intersects the tool's. Omit `roles` and the tool falls back to the module's `defaultRoles`.
- **`ability`** (delegated to an ability-aware policy): `@AiTool({ ability: 'cache.purge' })` — checked
  by [`@dudousxd/nestjs-authz`](https://github.com/DavideCarvalho/aviary) via
  `gate.forUser(actor).allows(ability)` once you add `AgentAuthzModule`. Tools without an `ability`
  fall back to the role policy, so non-authz apps are unaffected.

```ts
@Module({ imports: [AuthzModule.forRoot(/* … */), AgentAuthzModule.forRoot()] })
export class AppModule {}

@AiTool({ name: 'purgeCache', kind: 'action', description: '…', input: z.object({ key: z.string() }),
          ability: 'cache.purge' })
export class PurgeCacheTool implements ToolHandler<{ key: string }> { /* … */ }
```

### Turning a tool off, and gating it per user

`roles`/`ability` answer "may this actor use it?" with one app-wide policy, and an agent's `tools`
allow-list is fixed when the agent is declared. Two optional methods on the handler answer the
questions those can't, per turn and with DI:

- **`isEnabled()`** — does this capability exist in this deployment at all? The feature-flag seam.
- **`canUse(actor)`** — may THIS actor use it? The per-user seam, next to the tool that knows what
  to ask (a plan, an entitlement row, ownership of the record in question).

```ts
@AiTool({ name: 'searchDocs', kind: 'read', description: '…', input: schema })
export class SearchDocsTool implements ToolHandler<Input> {
  constructor(private readonly config: ConfigService, private readonly plans: PlanService) {}

  isEnabled() { return this.config.get('DOCS_SEARCH_ENABLED') === 'true'; }
  canUse(actor: Actor) { return this.plans.includesDocSearch(actor.tenantRef); }

  async execute(input, ctx) { /* … */ }
}
```

Both run when the turn's tool list is built, so a tool that fails either is **never shown to the
model** — no wasted step, no refusal that tells the user a capability exists. Both run again on
invoke, which is what stops a HITL action approved before the flag moved from executing after it.
Every gate can only remove tools: `isEnabled`, then the roles policy, then `canUse`, then the
agent's allow-list. A disabled tool raises `ToolDisabledError`, distinct from `ToolForbiddenError`
(wrong actor) and `ToolNotFoundError` (no such tool) — three different things to go fix.

For availability that needs no injected service, the decorator takes it directly:
`@AiTool({ enabled: false })`, or `enabled: () => process.env.FLAG === 'true'` (re-read every turn).

## Governed SQL (`-data`)

Give the model read-only SQL access without handing it the database. Every query is AST-validated
(single SELECT only), checked against a fail-closed table-access policy, optionally rewritten to
scope it to the caller's tenant, and capped with a LIMIT — before your injected runner touches the
DB.

```ts
import { createExecuteSqlTool, GroupTableAccessPolicy, TenantScopeRewriter } from '@dudousxd/nestjs-agent-data';

// returns a { spec, handler } pair — register it with the tool registry at bootstrap
const { spec, handler } = createExecuteSqlTool({
  runner: { run: (sql) => readOnlyPool.query(sql) },           // you supply the pool
  tableAccess: new GroupTableAccessPolicy({ roleGroups, tablesByGroup }),
  tenantScope: new TenantScopeRewriter({ tenantColumn: 'tenant_id', scopedTables: ['orders'] }),
});
```

## Tools from an MCP server (`-mcp`)

Import an external [MCP](https://modelcontextprotocol.io) server's tools instead of writing an
`@AiTool` class for each. They land in the same registry as your own, so they inherit every gate —
`roles` / `ability` / `canUse`, an agent's allow-list, HITL approval, tool-call rows in the thread
and the dashboard.

```ts
import { AgentMcpModule } from '@dudousxd/nestjs-agent-mcp';

AgentMcpModule.forRoot({
  servers: [
    { name: 'github', transport: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] }, roles: ['ADMIN'] },
    { name: 'docs', transport: { type: 'http', url: 'https://mcp.example.com/mcp' }, kind: 'read', include: ['search_docs'] },
  ],
});
```

- **An imported tool is an `action` by default** — it waits for a human. Its effects live outside
  this codebase, and the server's own `readOnlyHint` is asserted by the party whose effects it
  describes, so believing it (`kind: 'trust-annotations'`) is an explicit decision, as is
  `kind: 'read'` for a server you own.
- **The server's JSON Schema is enforced**, not approximated: the model's arguments are validated
  against the real schema before the call goes out, and a tool whose schema won't compile is skipped
  rather than imported behind a permissive stand-in.
- **A slow or missing server costs its own tools, nothing else.** An unreachable server at boot is a
  warning (`required: true` to make it fatal); a hung call hits the SDK's request timeout; a dropped
  connection is classified transient, recycled and retried through core's `invokeWithTransientRetry`.
- Tool names are **namespaced under the server** (`github_create_issue`), so a remote tool can never
  silently take over one of yours.

See [`packages/mcp`](./packages/mcp) for the full option surface.

## Your tools to an MCP client (`-mcp-server`)

The other direction: mount a Streamable HTTP MCP endpoint so an external client — Claude Desktop, an
editor, a CI job — can reach the tools this deployment already has.

```ts
import { AgentMcpServerModule, BearerTokenActorResolver } from '@dudousxd/nestjs-agent-mcp-server';

AgentMcpServerModule.forRoot({
  name: 'Acme Agent',
  version: '1.0.0',
  auth: new BearerTokenActorResolver([
    { token: process.env.MCP_CI_TOKEN ?? '', actor: { id: 'ci', roles: ['ANALYST'] } },
  ]),
});
```

- **The same registry and the same `RolesPolicy` as a turn.** `tools/list` is
  `definitionsFor(actor, policy, allowedTools)` and `tools/call` is `invoke` — no second gate to
  drift out of step with the loop's.
- **An `action` tool is not callable by default.** It is HITL-gated in a turn, and there is nobody on
  an MCP connection to approve it, so it is neither listed nor callable. `actions: 'execute'` is the
  deployment saying out loud that this caller may act without approval.
- **Identity is required and never invented.** `auth` is the same `ActorResolver` seam `AgentModule`
  takes, with no default actor and no default role; a caller it cannot identify gets **401**, not 500.
- **A session belongs to the actor that opened it** — a request authenticating as somebody else is
  403, not served on it.

See [`packages/mcp-server`](./packages/mcp-server) for the full option surface.

## Frontend (`-react`)

`useAgentChat` wraps the Vercel AI SDK v7 `useChat` with a transport for the `/agent/chat` SSE,
plus threads, personas, quota, cancel, and HITL approve/reject. `useChatTranscript` turns the
streamed messages into a renderable model — parts grouped into text/reasoning/tool runs, per-message
derived values, each action a state machine, plus list windowing and stick-to-bottom — and
`MessageList`/`MessageItem`/`ChatInput` are one rendering of it, styling-agnostic and optional. The
optional `@dudousxd/nestjs-agent-react/markdown` subpath ships a full streamdown renderer (GFM,
KaTeX, syntax-highlighted code, Mermaid) you can drop into the `renderText` slot.

```tsx
// baseUrl is the origin (default '' = same origin); the transport appends '/agent/chat' itself
const chat = useAgentChat({ getHeaders: () => ({ 'x-actor-id': me.id, 'x-actor-role': me.roles.join(',') }) });
```

## Observability (diagnostics)

The agent emits `aviary:agent:*` events (`run.started`, `message`, `tool-call`, `delegated`,
`quota.exceeded`, `run.finished`, `run.failed`, `retrieved`, `tool.retry`) on Node's
`diagnostics_channel`. `@dudousxd/nestjs-agent-telescope` consumes them for a dashboard tab; any app
can subscribe for its own metrics, alerts, or an orchestration graph — the library instruments
nothing in your code.

## Cost & governance

Every turn writes a usage-ledger row (`agent_token_usage`); the read-model
(`AgentGovernanceQueries`) rolls those up into spend per model, per actor, a usage trend, and recent
tool-call / thread activity. Cost is resolved **per row**:

```text
costUsd = COALESCE(reportedCostUsd, cache-aware token estimate)
```

- **Provider-reported cost wins.** A gateway that knows the real spend of a turn — Vercel AI Gateway
  (`providerMetadata.gateway.cost`), OpenRouter (`total_cost`) — reports it via `ModelTurnResult.costUsd`;
  the loop persists it to the nullable `cost_usd` column and the read-model uses it verbatim. Direct
  providers (Anthropic/OpenAI/Bedrock) report only tokens and fall through to the estimate.
- **The fallback estimate is cache-aware.** `MessageUsage` carries `cacheWriteTokens` / `cacheReadTokens`
  (subsets of `inputTokens`) and `reasoningTokens` (a subset of `outputTokens`, observability only).
  `AgentModelPricing` has nullable `cacheWritePricePer1m` / `cacheReadPricePer1m` rates: the uncached
  remainder is priced at the input rate, cache-write/read at their own rates (falling back to the input
  rate when unset). Because the cache counts are subsets, token totals and quota never change — a pricing
  table with no cache data reduces exactly to `input×inputPrice + output×outputPrice`.

Surface it either way: **`@dudousxd/nestjs-agent-telescope`** adds governance sections to a Telescope
install, or **`@dudousxd/nestjs-agent-dashboard`** mounts a standalone console (a bundled React SPA
served by a NestJS module) at its own route with no Telescope dependency:

```ts
import { AgentDashboardModule } from '@dudousxd/nestjs-agent-dashboard';

@Module({ imports: [AgentDashboardModule.forRoot({ basePath: '/ai-gateway' })] })
export class AppModule {}
```

Both read the same `AGENT_GOVERNANCE_QUERIES` read-model (bound by the store modules) and tail live
tool-call / quota signals off the `aviary:agent:*` diagnostics channel.

## Evals & scorers (`-evals`)

Cost and reliability say what a turn *spent* and whether it *finished*. `@dudousxd/nestjs-agent-evals`
says whether it was any **good** — a `0..1` score plus the sentence that justifies it, tracked over
time. Scoring is **offline-first**: it reads runs the agent already persisted (`AgentGovernanceQueries`
+ `AgentStore`), so nothing sits inside a turn adding latency or cost to every message a user sends.

```ts
import {
  ApprovalOutcomeScorer, ApprovalRiskScorer, GovernanceRunSampleSource,
  InMemoryScoreStore, RunCompletionScorer, loadApprovalPrior, runEvaluation, summarizeByScorer,
} from '@dudousxd/nestjs-agent-evals';

const scores = new InMemoryScoreStore();          // or your own ScoreStore adapter
await runEvaluation({
  source: new GovernanceRunSampleSource(governanceQueries, agentStore),
  scorers: [
    new RunCompletionScorer(),
    new ApprovalOutcomeScorer(),
    new ApprovalRiskScorer(await loadApprovalPrior(governanceQueries)),
  ],
  store: scores,
  query: { limit: 500, fromDay: '2026-09-01', toDay: '2026-09-07' },
});
summarizeByScorer(await scores.listScores({}));   // worst mean first
```

**The HITL signal is the point.** Because an `action` tool pauses for a human approve/reject, **every
rejection is a negative quality label a human produced for free** — in the words of the domain, at
the moment it mattered. `ApprovalOutcomeScorer` reads those verdicts back as the fraction of a run's
decided actions a human approved; `ApprovalRiskScorer` turns the same corpus into a Beta-smoothed
prior so a pending-approvals inbox can be drained riskiest-first, before anyone looks.

The four built-ins cover the three families: `RunCompletionScorer` + `ApprovalOutcomeScorer`
(`rule`), `ApprovalRiskScorer` (`statistical`), `AnswerRelevancyScorer` (`model`, LLM-as-judge over
any `ModelProvider`). A scorer returns `null` — not `1` — for a run it has nothing to say about, so
the runs carrying a real verdict aren't buried under an average of ~1; a scorer that throws is
collected as a per-run failure and the batch carries on.

`runEvaluation` skips a `(run, scorer)` pair the store has already seen, so an interrupted backfill
restarted with the same query re-bills nothing. Optionally, `attachLiveScoring` scores runs as they
finish off the `aviary:agent:run.finished` channel — opt-in, after the run has settled, in a guarded
detached promise, so there is no path from a scorer back into a turn.

## Example

`examples/agent-demo` is a runnable, fully-offline proof (`pnpm --filter agent-demo demo`): a read
tool auto-executing, an action tool suspending on a durable HITL signal and resuming on approval, and
an orchestrator delegating to a sub-agent — all with the in-memory store + a deterministic fake model,
no API key or Redis. `pnpm --filter agent-demo start` boots the full NestJS app with the governance
console mounted at `/ai-gateway`. See `docs/superpowers/specs/` for the API and governance-console
design specs.

## Status

Early development (`0.x`). The package surface and SPIs are stabilizing.

## License

MIT © Davide Carvalho
