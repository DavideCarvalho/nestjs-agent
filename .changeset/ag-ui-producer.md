---
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent": minor
"@dudousxd/nestjs-agent-store-drizzle": patch
"@dudousxd/nestjs-agent-store-mikro-orm": patch
---

Serve the agent over AG-UI 1.0: `AgentModule.forRoot({ adapters: [agUiAdapter()] })` mounts
`POST <path>/ag-ui` — a `RunAgentInput` in, AG-UI events out, behind the same actor resolver, guards
and ownership checks as `chat`. A run that parks on an approval or a question set ends with the
interrupt outcome and is continued by a later request carrying `resume`; inline media parts are
staged through the attachment store; `RUN_FINISHED.usage` is reported per model.

- core: the encoder is framework-free in `@dudousxd/nestjs-agent-core/ag-ui` (`AgUiEncoder`,
  `agUiEvents`, `agUiFramesFromNdjson`, the `RunAgentInput` readers, the interrupt-id codec), shared
  with `@adonis-agora/agent`.
- core: `step-finish` names its `model` (optional field on the shared frame).
- core: `CreateThreadInput.id` — create a thread under a caller-chosen id (optional to honour); the
  in-memory, Drizzle and MikroORM stores honour it and refuse an id already taken.
- nestjs: `adapters` on `AgentModule` (`AgentProtocolAdapter`), `AgentService.threadOwner`,
  `assertResumable`, `checkDecision`, `checkAnswer`, and `ChatParams.newThreadId`.
