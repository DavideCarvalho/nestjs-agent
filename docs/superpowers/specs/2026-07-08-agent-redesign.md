# Agent Redesign: `@Agent` by-class, prompt contributors, persona removal

**Date:** 2026-07-08
**Status:** Design approved (Davi, this session) — implementation in progress
**Origin:** Planning the flip-nestjs integration surfaced three things: (1) `persona` is a
flip-specific flavor that shouldn't be a library primitive; (2) the genuinely generic need is
*multiple agents*; (3) cramming agents into `forRoot({ agents: [...] })` is not idiomatic NestJS —
the idiomatic shape is decorated provider classes discovered via `DiscoveryService`, because an
agent needs DI (its retriever, schema service, policy are providers).

## Goal

Reorient the library from "one configurable agent + swappable personas" to "a registry of
first-class agents, each a decorated provider class." Delete `persona` entirely. Expose the prompt
as a composition seam so an app (flip) plugs in domain sections without forking.

## Decisions (locked)

| Area | Decision |
|---|---|
| Agent definition | A `@Agent({...})`-decorated **class**, discovered at boot (not `forRoot({agents})` / not `forFeature([def])`). DI-injected. |
| `forRoot` | **Engine only**: `model`, `store`, `durable`, `actorResolver`, quota, sink, timeouts, followUps, retrieval. **No agent config.** |
| Persona | **Deleted** from the library. flip's personas become either distinct agents or app-side prompt sections. |
| Base prompt | `@SystemPrompt()` **method on the `@Agent` class** (may be dynamic — injected deps + `PromptContext`). Replaces `AgentDefinition.systemPrompt` and persona prompt-wrapping. |
| Cross-agent prompt | `@SystemPromptContributor()` **method on an `@Injectable` provider** — ordered dynamic sections that apply across agents (base-scope, mentions legend, schema hints). Reads open `thread.metadata`. |
| Tool authorization | **Reuse the existing `RolesPolicy` SPI** (`can(actor, tool)`) — it already *is* the tool authorizer. `DefaultRolesPolicy` (role-in-`spec.roles`) is the batteries-included default. **No authz dependency**; `nestjs-authz` stays an opt-in policy. |
| Actor | Stays lean: `{ id, roles?, tenantRef? }`. App's `actorResolver` fills it (flip: `user.role.name` → `roles`). |
| Tool scope | `@AiTool` **inside** an `@Agent` class = that agent's tool; on a standalone `@Injectable` = global tool (existing `provideAgentTool` path still works for functional tools). |
| Selection | By class at the boundary: `agentService.chat(SqlAnalystAgent, {...})`; a name string only at the HTTP edge / persisted on the message. |
| Handoff / sub-agents | By class: `ctx.handoff(OtherAgent)` (replaces `delegatesTo` string + `ask_<name>`). Durable = `ctx.child`; inline = nested loop. |
| Model | `@Agent({ model })` as a key resolved against a model registry in `forRoot`, with an optional `@ModelFor()` method escape hatch for dynamic selection. |
| Message provenance | `message.agentName` records which agent produced it (persistence + telescope + UI). |
| Runner | Durable-first (flip standardizes on durable). Inline runner stays as the no-durable fallback. |

## The API (target)

```ts
@Agent({
  name: 'sql-analyst',
  description: 'Answers questions by querying the warehouse',
  model: 'bedrock:claude-opus-4-8',   // key resolved by forRoot's model registry
})
export class SqlAnalystAgent {
  constructor(private readonly schema: SchemaService) {}   // DI — the reason for a class

  @SystemPrompt()
  buildPrompt(ctx: PromptContext): string {
    return `You are a SQL analyst.\nSchema:\n${this.schema.describe(ctx.actor)}`;
  }

  @AiTool({ kind: 'read', description: 'Run a read-only SQL query',
            input: z.object({ query: z.string() }), roles: ['analyst'] })
  async runSql({ query }: { query: string }, ctx: AiToolCtx) {
    return this.warehouse.runGoverned(query, ctx.actor);
  }
}

// cross-agent dynamic prompt section — an ordinary provider, injects app services
@Injectable()
export class BaseScopeContributor {
  @SystemPromptContributor()
  contribute(ctx: PromptContext): string | null {
    const baseId = ctx.thread.metadata?.baseId;
    return baseId === undefined ? null : `You are scoped to base ${baseId}.`;
  }
}

@Module({
  imports: [
    AgentModule.forRoot({
      models: { 'bedrock:claude-opus-4-8': aiSdkModel(bedrock('...')) },
      actorResolver: MyActorResolver,
      store, durable: true,
    }),
  ],
  providers: [SqlAnalystAgent, BaseScopeContributor],   // discovered — not listed in forRoot
})
export class AiModule {}
```

### Prompt composition (per turn, for the selected agent)

```
[library governance rules]
  + [the agent's @SystemPrompt(ctx)]           // per-agent base
  + [each @SystemPromptContributor(ctx), in order, skipping null]   // cross-agent dynamic
  + [inject-mode RAG block, if configured]     // existing
```

`null` from a contributor = contributes nothing this turn (conditional sections stay clean). Order
is discovery order; a numeric `order` option on the decorator can pin it if needed.

### `PromptContext`

```ts
interface PromptContext {
  actor: Actor;             // { id, roles?, tenantRef? }
  thread: { id: string; metadata?: Record<string, unknown> };  // open metadata bag
  agentName: string;        // the selected agent
  messages: AgentMessage[]; // history, if a contributor needs it
}
```

## What gets deleted (persona)

- `packages/core/src/personas.ts` — `Persona` type, `personaFilterTools` (the second filter layer).
- `Persona` from `packages/core/src/types.ts`; `AiToolCtx.persona`; `PromptContext`/`PromptBuilder`
  persona-wrapping.
- `forRoot`/`AgentDefinition` persona fields; persona selection in the chat service + controllers.
- `-react`: persona props on `useAgentChat`, persona pickers, `persona` in the transport/body.
- Persona rows in docs (`guides/*`, package READMEs) and the demo.

Migration for a persona today:
- **Prompt-only persona** → a `@SystemPromptContributor` (or a distinct `@Agent` if it also changes
  tools/model).
- **Persona with an `allowedTools` allow-list** → model it as a **distinct `@Agent`** whose class
  owns only those `@AiTool`s (capability becomes a real boundary, not a filter). This is the
  security upgrade the redesign buys: least-privilege per agent instead of a prompt-time filter.

## What changes (existing → new)

- `AgentDefinition` config object → `@Agent` class + `AgentRegistry` populated by discovery (not by
  `forFeature`). Keep an internal `AgentDefinition`-shaped record built *from* the decorated class
  (name, description, model key, systemPrompt fn, tool names, handoff targets) so the loop and
  `AgentDepsFactory` change minimally.
- `AgentModule.forFeature([def])` → **removed**; agents are providers in a module's `providers`.
- `defaultAgent` on `forRoot` → **removed**; a single-agent app declares one `@Agent` (or the lib
  falls back to a bare unnamed agent when none is discovered — TBD, keep a zero-agent bare mode).
- `AgentDepsFactory.forAgent(name)` → resolves from the discovered registry instead of the
  definition array; per-agent `@SystemPrompt` invoked here.
- Delegation `delegatesTo: string[]` + `ask_<name>` synthesis → `handoff: [OtherAgent]` by class;
  `ctx.handoff(cls)`; the delegate-tool synthesis keys on the class's registered name.
- `AiToolCtx` gains nothing; loses `persona`.

## Discovery mechanics

Follow the existing `AiToolDiscoveryService` pattern (already uses `DiscoveryService` +
`MetadataScanner`):
- `@Agent` sets class metadata (`AGENT_METADATA = Symbol.for(...)`). A new
  `AgentDiscoveryService` (onModuleInit) scans providers, reads the metadata, resolves the instance,
  reads its `@SystemPrompt`/`@AiTool`/`@ModelFor` methods, and registers an agent record into
  `AgentRegistry`.
- `@SystemPromptContributor` methods collected app-wide into an ordered `PromptContributor[]`
  (bound under a new `AGENT_PROMPT_CONTRIBUTORS` token) the loop consumes during prompt assembly.
- All new tokens are `Symbol.for(...)` (dual-bundle DI safety, per the existing `AGENT_DEPS_FACTORY`
  lesson).

## Non-goals (this pass)

- No `nestjs-authz` wiring (opt-in later; `RolesPolicy` already accepts an authz-backed impl).
- No model *routing* (single provider per agent via the model registry; the gateway view stays
  observability, not routing).
- No change to the durable control-plane / streaming split, the store SPI, or the governance
  read-model — only agent definition, prompt, and persona removal.

## Testing

- Core: agent registry from discovery; prompt composition (base + ordered contributors + null-skip);
  persona-deletion regressions (no `Persona` symbol remains).
- nestjs: `@Agent`/`@SystemPrompt`/`@SystemPromptContributor`/`@AiTool` discovery e2e (Nest test
  module boots, registry populated, a turn selects an agent and sees contributor sections);
  agent-scoped vs global tool visibility; handoff-by-class resolves to the right child.
- Stores + testing fakes: `message.agentName` persisted/read.
- Keep the existing suite green (204 unit + db); update persona specs to the new model.
- flip integration smoke (separate worktree): a `@Agent` + a `BaseScopeContributor` + a role-gated
  `@AiTool`, booting against flip's DI, proving the ancestor `admin-ai` maps onto the new surface.

## As-built notes (scope decisions this pass)

To land a coherent, green increment, a few refinements to the sketch above:

- **Tool authorization reuses the existing `RolesPolicy` SPI** rather than adding a `ToolAuthorizer`.
  `RolesPolicy.can(actor, tool)` already *is* the tool authorizer; `DefaultRolesPolicy`
  (role-in-`spec.roles`) is the batteries-included default. No new SPI, no authz dependency.
- **`PromptContext` is `{ actor, agentName, pageContext? }`** — the `thread.metadata` open bag is
  deferred (it needs a store column). Contributors read `actor.tenantRef` (already carried) and
  their own injected services instead; that covers flip's base-scope without a schema change.
- **Per-agent model *providers* deferred.** `@Agent({ model })` is an accounting label mapped to the
  existing `modelId`; the model provider stays shared (as today). Real per-agent providers (a model
  registry) are a follow-up — the multi-agent value here is per-agent prompt/tools/policy.
- **Agent tool scoping is the `tools` allow-list** of global `@AiTool` names. Method-level
  `@AiTool` co-located inside an `@Agent` class is a follow-up; today an agent lists which global
  tools it may use (still a real least-privilege boundary via the existing role filter).
- **`defaultAgent` is now a `string`** (the agent name) on `forRoot`, defaulting to the sole
  registered `@Agent` when there's exactly one, else `'default'`.
- **`message.agentName`** persisted as a nullable column on the message table (stores + testing).

## Rollout

Nothing depends on the current API except the fresh `0.1.0` baseline and flip (not yet migrated),
so this lands as a breaking `minor` on the 0.x line (a future Version PR / graduation decision is
separate). Implement in green, committed waves on the lib; wire flip in its worktree via a
`pnpm-workspace` include (dedups peers, unlike `pnpm link`).
