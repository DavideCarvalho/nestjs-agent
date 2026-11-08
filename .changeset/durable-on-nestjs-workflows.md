---
"@dudousxd/nestjs-agent": major
"@dudousxd/nestjs-agent-core": minor
---

`durable: true` runs turns on NestJS's [`@nestjs/workflows`](https://docs.nestjs.com/reliability/workflows). Import `WorkflowsModule.forRoot()` and `AgentWorkflowsModule` from the new `@dudousxd/nestjs-agent/workflows` subpath (`@nestjs/workflows >=0.0.5 <0.1` is an optional peer, never imported by the main entry). Each turn is the `aviary.agent.run` workflow: each model call and each tool call is a `ctx.step` (a model configuration error is a `NonRetryableStepError`; a tool's failure is a result the model reads, and a tool step runs again only after a crash, with the same `ctx.idempotencyKey`), a person's approval or answers are `ctx.waitForSignal(AGENT_REPLY, { key: '<runId>:<toolCallId>' })` (listed meanwhile in the instance's custom status: `WorkflowsAgentRunner.pendingReplies(runId)`), an awaited sub-agent is `ctx.executeChild`, a detached one and the thread's next queued message are `ctx.startChild(..., { parentClose: 'abandon' })`, Stop is `WorkflowClient.cancel`. After `stepsPerInstance` model calls (default 10) a turn goes on in a child instance, so no journal grows without end. On an API pod, `WorkflowsModule.forRoot({ worker: false })` replaces `AgentDurableModule.forRoot({ surface: 'http' })`. An app with `durable: true` and no `WorkflowsModule` or no `AgentWorkflowsModule` fails at boot, naming the import.

`durable: { engine: 'aviary' }` keeps today's `@dudousxd/nestjs-durable` path unchanged (`DurableModule` + `AgentDurableModule`, or `agentDurable()`, which now sets it): choose it for steps dispatched to a fleet over a transport (BullMQ, SQS), Python workers, the SQLite/MikroORM stores, or `ctx.patched`.

Migration: `durable: true` now means `@nestjs/workflows`. An app on `AgentDurableModule` sets `durable: { engine: 'aviary' }` to stay where it is. Turns in flight can't move engines: an `agent.run` run started on `@dudousxd/nestjs-durable` only finishes there, so drain them (or keep `engine: 'aviary'`) before switching. Channels (`@dudousxd/nestjs-agent-channels`) still move onto a durable engine only on `aviary`.

`@dudousxd/nestjs-agent-core` adds the `AGENT_WORKFLOWS_RUNNER` token.
