# nestjs-agent — pre-1.0 public API design

**Status:** designed 2026-07-03. Nothing is published yet, so every change here is a free breaking change; the goal is to freeze an OSS-quality surface before the first npm release.

**Goal:** harden the public API of `@dudousxd/nestjs-agent` and its satellites so a third-party app can adopt it without hitting footguns, hardcoded assumptions, or leaky internals. Resolves 11 audit findings; the flip admin-ai migration is the reference consumer.

**Guiding principles:** (1) no insecure defaults; (2) everything agent-shaped is an `AgentDefinition`; (3) the app owns auth/identity — the lib provides seams, not assumptions; (4) match the aviary family conventions (`Symbol.for` tokens, validation-agnostic where the ecosystem is, optional peers isolated); (5) YAGNI — add extension points only where a real consumer (flip) needs them.

---

## 1. `ActorResolver` SPI — the app owns identity (Tier 1, security)

**Problem.** `resolveActor(req)` reads fixed `x-actor-*` headers and, on miss, returns `{ id: 'demo-user', role: 'ADMIN' }`. There is no seam to plug real auth, and the ADMIN fallback means a mis-wired app silently authorizes everyone.

**Design.** New core SPI:
```ts
export interface ActorResolver {
  /** Resolve the acting user from the transport request (Express/Fastify req, or any host object). */
  resolve(request: unknown): Actor | Promise<Actor>;
}
```
- Bound via `AGENT_ACTOR_RESOLVER = Symbol.for('@dudousxd/nestjs-agent:actor-resolver')`.
- `AgentModule.forRoot({ actorResolver })` (or a provider) sets it. **No default that fabricates an actor.** If none is configured, resolution throws a loud error naming the fix.
- Ship an explicit, opt-in `HeaderActorResolver` (reads `x-actor-id`/`x-actor-role`/`x-tenant-ref`, throws when `x-actor-id` is absent — no ADMIN fallback) for demos/curl and simple setups. Apps wire their own (session, JWT, `@dudousxd/nestjs-context`) by implementing the one-method SPI.
- Controllers call `await resolver.resolve(req)` instead of the free `resolveActor()`. `resolveActor` is removed from the public API.

## 2. `Actor.roles: string[]` — multi-role (Tier 1)

**Problem.** `Actor.role?: string` assumes a single role; real apps carry several.

**Design.**
```ts
export interface Actor { id: string; roles?: string[]; tenantRef?: string }
```
- `DefaultRolesPolicy.can` → allow when `intersect(actor.roles ?? [], tool.roles ?? defaultRoles)` is non-empty.
- `AuthzRolesPolicy.userFromActor` maps `roles`.
- Everything else keys off `actor.id` and is unaffected.

## 3. Persona & agent model + dynamic prompts (Tier 1)

**Problem.** `Persona` and `AgentDefinition` overlap (both carry `systemPrompt`/tools/`modelId`), and `Persona.systemPrompt` is a flat string — flip composes prompts dynamically (`buildPrompt` + schema injection), which doesn't fit.

**Design — firm the mental model.**
- **`AgentDefinition`** = a *named actor* registered via `forFeature` (or the module's default agent). It owns a base system prompt, a tool allow-list, delegation edges, personas, and model/step config.
- **`Persona`** = a *per-request variant* within one agent — swaps the system prompt and/or narrows tools for a single turn. Chosen by the `persona` field on the chat request.
- Allow dynamic prompts:
```ts
export type PromptBuilder = (ctx: PromptContext) => string | Promise<string>;
export interface PromptContext { actor: Actor; persona?: Persona; pageContext?: PageContext; basePrompt: string }
export interface Persona { id: string; label: string; systemPrompt: string | PromptBuilder; allowedTools?: string[] }
export interface AgentDefinition { name: string; systemPrompt?: string | PromptBuilder; /* …unchanged… */ }
```
The loop resolves the effective system prompt at one point, awaiting the builder when it's a function. flip's `unit-matcher` becomes a normal persona/agent again (no `forFeature` workaround forced).

## 4. `model` vs `modelId` — kill the drift (Tier 2)

**Problem.** `forRoot` takes both `model` (the runtime) and `modelId` (the accounting label); they can silently disagree, mis-attributing cost.

**Design.**
```ts
export interface ModelTurnResult { text: string; toolCalls: ToolCallRequest[]; usage: MessageUsage; modelId?: string }
```
- The provider reports the model it actually ran. The loop records `result.modelId ?? deps.modelId`.
- `forRoot`/`AgentDefinition` `modelId` becomes **optional** — set it only to override or when the provider can't report one.

## 5. Configurable route prefix (Tier 2)

**Problem.** Controllers hardcode `@Controller('agent/...')`; apps mount under `/api` or want a different name.

**Design.** `forRoot({ path?: string })` (default `'agent'`). Controllers become path-relative (`@Controller('threads')`, …) and are mounted under `path` via Nest's `RouterModule.register`. The React client/codegen already take a `baseUrl`/`basePath`, so this composes.

## 6. `forRoot` shape: infra vs the default agent (Tier 2)

**Problem.** `forRoot` is a 13-field flat bag mixing infrastructure with the implicit default agent's config.

**Design.**
```ts
AgentModule.forRoot({
  // infrastructure
  model, store, sink?, quota?, rolesPolicy?, defaultRoles?, actorResolver?, path?, durable?,
  // the default agent (optional — omit for a bare assistant)
  defaultAgent?: AgentDefinition,   // { name?: 'default', systemPrompt?, personas?, defaultPersona?, modelId?, maxSteps? }
})
```
Loose `systemPrompt`/`personas`/`defaultPersona`/`maxSteps`/`modelId`/`defaultAgent(name)` fields collapse into one `defaultAgent: AgentDefinition`. One concept — everything agent-shaped is an `AgentDefinition`, whether it's the default or a `forFeature` one.

## 7. Public `ToolKind` split (Tier 3)

**Problem.** `@AiTool({ kind })` accepts `'agent'`, but users never set that — it's synthesized for delegation.

**Design.** The decorator's `AiToolOptions.kind` is `'read' | 'action'`. Core's `ToolKind` keeps `'agent'` as an internal value the loop/registry use; it isn't offered on the authoring surface.

## 8. Durable opt-in stays two-step — documented, not changed (Tier 2, downgraded)

`durable: true` + importing `AgentDurableModule` is deliberate: it keeps the optional `@dudousxd/nestjs-durable` peer out of the inline code path. Collapsing to one switch would force the peer on inline users. **No code change** — document the two-step clearly and assert a helpful error if `durable: true` is set without the module present.

## 9. `roles` vs `ability` — documented (Tier 3)

Keep both on `@AiTool`. Document the choice: `roles` = the built-in role policy; `ability` = delegated to an ability-aware `RolesPolicy` (e.g. `AgentAuthzModule`). A tool sets one or the other.

## 10. Standard Schema for tool input — last phase / candidate follow-up (Tier 1 strategic, high-effort)

**Problem.** `@AiTool({ input: ZodType })` hard-couples Zod, while the aviary codegen family is validation-agnostic via Standard Schema (zod/valibot/arktype).

**Design (phased last).** Accept `StandardSchemaV1` for `input`; validate in the loop via `~standard.validate`; pass the schema to the `ModelProvider` (the Vercel AI SDK consumes Standard Schema for tool params natively). The one hard part is the JSON-schema the model sees when a provider needs it — resolved by leaning on the AI SDK's own Standard-Schema handling rather than converting ourselves. Sequenced last; may ship as `0.2` if it risks the rest.

## 11. Naming / export sweep (Tier 3)

A pass over barrels and exported names for consistency once 1–10 land (e.g. token names, `*Module.forRoot`/`forFeature` conventions, no stray internal exports). Small, done at the end.

---

## Phasing

1. **Identity & authz core** — ActorResolver SPI (+ HeaderActorResolver, remove insecure default), `Actor.roles[]`, `DefaultRolesPolicy`/`AuthzRolesPolicy` updates. *Highest value; security.*
2. **Agent model** — Persona/AgentDefinition dynamic `PromptBuilder`, loop resolves it; docs firming the mental model.
3. **Ergonomics** — `modelId` from provider result, configurable `path`, `forRoot({ defaultAgent })` restructure, `ToolKind` public split.
4. **Docs/hygiene** — durable two-step + roles/ability docs, error messages, naming sweep.
5. **(Strategic)** — Standard Schema tool input; may become a `0.2` follow-up.

## Migration impact (the reference consumer: flip admin-ai)

Nets in flip's favor — the dynamic-prompt personas stop needing the `forFeature` workaround, and flip plugs its real auth via `ActorResolver` instead of the header shim. Each change is a free breaking change pre-publish; the lib's own tests + demo move in lockstep.

## Testing

Every phase updates the lib's unit/e2e/db tests and the offline demo in lockstep (the demo is the integration proof). New coverage: an `ActorResolver` that throws when unresolved (no silent ADMIN); a multi-role `DefaultRolesPolicy` case; a dynamic-`PromptBuilder` persona; `modelId` sourced from the provider result; a custom `path` mounting the controllers.
