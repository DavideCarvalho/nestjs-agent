---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent': minor
'@dudousxd/nestjs-agent-react': minor
'@dudousxd/nestjs-agent-testing': minor
'@dudousxd/nestjs-agent-store-drizzle': minor
'@dudousxd/nestjs-agent-store-mikro-orm': minor
'@dudousxd/nestjs-agent-codegen': minor
---

Personas: named variants of ONE agent — their own prompt and, optionally, a narrower tool
allow-list — ported from `@adonis-agora/agent`, on the same wire.

- `@Agent({ personas: [{ id, label, description?, systemPrompt?, allowedTools?, aliases? }], defaultPersona })`.
  A flat persona prompt stands in for the agent's base prompt; a builder gets it as `ctx.basePrompt`.
  `PromptContext.persona` lets the agent's own `@SystemPrompt()` branch on it (DI-friendly).
- `POST <base>/chat { persona }` (AG-UI `forwardedProps.persona`, `AgentService.send({ personaId })`):
  send > thread pin > `defaultPersona` > none; a named persona is pinned on the thread
  (`ThreadSummary.persona`, `PATCH threads/:id { persona }`); `400 persona_not_found` otherwise.
- `allowedTools` narrows the offered list AND `ToolRegistry.invoke` (new `InvokeOptions.allowedTools`)
  and handoffs, after the agent allow-list, `enabled`, roles and `canUse`. Tools get `ctx.persona`.
- Durable-safe: the persona's id rides `AgentRunInput.persona` (and a queued message's `persona`); its
  definition is frozen once in a `persona:resolve` checkpoint that only a run naming one spends, so a
  parked run resumes on the persona it started with and runs from before the upgrade replay unchanged.
- `Persona.aliases` lets a persona answer for the agent name it replaced (sends, thread
  `defaultAgent`, queued messages, in-flight durable runs) — no data migration.
- `GET <base>/agents` lists each agent's `personas` and `defaultPersona`. Every message records
  `persona`.
- React: `useAgentChat({ persona })` + `threadPersona`, `useAgents().personasOf()/defaultPersonaOf()`,
  `persona`/`agentName` on transcript message metadata, `ThreadPatch.persona`.
- Stores: nullable `persona` on `agent_thread`, `agent_message` and `agent_queued_message`, added by
  `ensureAgentSchema` on both adapters (Drizzle's additive pass, MikroORM's safe update); hosts on
  their own migrations add the three columns. `personaForThread` projection on every adapter.

- Codegen: `persona` on messages, thread summaries, queued messages and the thread PATCH body;
  `personas`/`defaultPersona` on the agents catalog entry.

No `personas` → nothing changes.
