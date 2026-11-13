---
'@dudousxd/nestjs-agent': minor
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent-react': minor
---

A model per agent and per persona. `AgentModule.forRoot({ model: { fast: provider, smart: provider }, defaultModel: 'fast' })` configures named models; `@Agent({ model: 'smart' })` and a persona's new `model` run their turns on one. A turn runs on the catalog lock, else the send's `model`, else the thread's pin, else the persona's model, else the agent's, else the default. Every pick is checked against the catalog for the caller: a configured model the caller may not use answers `400 model_not_allowed`, naming the agent or persona. A delegated agent runs on its own model (journaled, so a replay keeps it), and a refused one becomes the tool's error. `GET /agent/models?agent=&persona=` answers that model as `default`, and `useModels({ persona })` / `useAgentChat` follow the chat's persona. Usage is labelled with the resolved model. A single `model` provider keeps working, and an agent `model` that names no configured model stays the accounting label, with one boot warning. Core adds `namedModels(…)` and `staticCatalogView(…)`.
