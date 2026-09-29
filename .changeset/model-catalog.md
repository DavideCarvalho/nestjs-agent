---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent': minor
'@dudousxd/nestjs-agent-react': minor
'@dudousxd/nestjs-agent-ai-sdk': minor
'@dudousxd/nestjs-agent-store-drizzle': minor
'@dudousxd/nestjs-agent-store-mikro-orm': minor
'@dudousxd/nestjs-agent-testing': minor
'@dudousxd/nestjs-agent-codegen': minor
---

Model catalog, per-thread and per-send model selection, model/agent picker hooks.

- core: `ModelCatalog` SPI (`list({ actor, agent }) → { providers: [{ id, label, models: [{ id, label, description?, badges?, available, unavailableReason?, contextWindow? }] }], default }`), `staticModelCatalog`, `findCatalogModel`, `withSelectedModel`, `AGENT_MODEL_CATALOG`. `ModelTurnArgs.model`, `AgentRunInput.model`, `LlmStepEnvelope.model`, `ThreadSummary.model`, `UpdateThreadInput.model`. A turn with a selected model runs every call (answer, structured output, follow-ups, dispatched steps) on it and labels usage with it when the provider reports no model id.
- nestjs: `AgentModule.forRoot({ models })`; `GET models?agent=` (`ModelsController`; empty catalog when none is bound); `POST chat { model }`; `PATCH threads/:id { model }` (`null` unpins). A model is refused with 400 unless the catalog lists it as available for the actor and agent — checked when pinned and again on every turn. Thread reads normalize `model` to `null`.
- ai-sdk: `aiSdkModel(model, { resolveModel })` runs the picked id; without a resolver a gateway string id is swapped for the pick and a provider instance ignores it.
- store-drizzle / store-mikro-orm / testing: `agent_thread.model` (nullable, added by `ensureAgentSchema`, copied on fork), `modelForThread`.
- react: `useModels({ backend, agent })` (grouped + flattened options, `find`, `defaultModel`), `useAgents({ backend })`; `AgentBackend.listModels?` / `listAgents?` (and `AgentClient` methods); `useAgentChat({ model })` sends it with every turn; `chat.setThreadModel(id | null)`; `ThreadPatch.model`.
- codegen: `GET /agent/models` as `agent.models.list`; thread summaries carry `defaultAgent`/`activeRunId`/`model`; the thread PATCH body takes `title?`/`defaultAgent?`/`model?`.
