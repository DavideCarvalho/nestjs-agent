---
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent": minor
"@dudousxd/nestjs-agent-store-mikro-orm": minor
"@dudousxd/nestjs-agent-store-drizzle": minor
"@dudousxd/nestjs-agent-testing": minor
"@dudousxd/nestjs-agent-react": minor
"@dudousxd/nestjs-agent-codegen": minor
"@dudousxd/nestjs-agent-dashboard": minor
---

Agent redesign: agents are `@Agent` classes, prompts compose via contributors, and `persona` is removed.

Reorients the library from "one configurable agent + swappable personas" to "a registry of
first-class agents, each a decorated provider class." An agent is authored as an `@Agent`-decorated
class discovered at boot (via `DiscoveryService`), so it gets DI — the reason an agent is a class,
not a config object.

- **`@Agent({ name, description?, systemPrompt?, model?, maxSteps?, tools?, handoff? })`** — a
  provider class registered into the `AgentRegistry` by the new `AgentDiscoveryService`. `tools` is
  an allow-list of global `@AiTool` names; `handoff` is other `@Agent` classes (resolved to names,
  exposed as handoff tools). Replaces `AgentModule.forFeature([...])` (removed) and the
  `forRoot({ defaultAgent: {...} })` object (now `defaultAgent?: string`, the default agent's name).
- **`@SystemPrompt()`** — a method on an `@Agent` class that builds the agent's dynamic base prompt
  from `PromptContext` (can inject services). **`@SystemPromptContributor()`** — a method on any
  provider returning an ordered prompt section (or `null` to skip), appended across every agent. The
  loop composes `base + contributors`, the seam an app uses to inject domain sections (base scope,
  a mentions legend, schema hints) without forking.
- **`persona` removed everywhere** — the `Persona` type, `personaFilterTools` (now
  `filterToolsByAllowList`), `AgentRunInput.persona`, `AgentDefinition.personas`/`.defaultPersona`,
  `ThreadSummary.persona`, `AiToolCtx.persona`, `CreateThreadInput.persona`,
  `AppendMessageInput.persona`, the `GET threads/personas/catalog` route, and the React persona
  props. A prompt-only persona becomes a contributor; a persona with a tool allow-list becomes a
  distinct `@Agent` (capability as a real boundary, not a prompt-time filter).
- **`message.agentName`** — assistant messages record which agent produced them (a nullable column
  on the message table in both stores; provenance for replay / UI / telescope).
- Tool authorization is unchanged: the existing `RolesPolicy` SPI (`DefaultRolesPolicy` default) is
  the tool authorizer — no new SPI, no authz dependency.
