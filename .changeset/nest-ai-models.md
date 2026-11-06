---
"@dudousxd/nestjs-agent": major
"@dudousxd/nestjs-agent-ai-sdk": minor
---

The agent runs on `@nestjs/ai`. With no `model` configured, `AgentModule` takes its models from the application's `AiModule.forRoot({ models })` — found wherever it is imported — and runs each turn under what `AiModule` configures for the model: its settings, `retry` / `timeout` (or `resilience` policy or preset), `fallback` models, `onUsage`, and `pricing` (seeded as price rows). The picker lists `AiModule`'s models by name. As in `@nestjs/ai`, the timeout is the time to the first frame, and once a frame has reached the reader nothing is retried and no other model takes over.

Breaking: `@nestjs/ai`, `@nestjs/resilience` and `ai` are peer dependencies; NestJS 12 and Node 22 are required (the floors of `@nestjs/ai`). A missing `model` is no longer refused at `forRoot`: the boot fails instead when there is no `AiModule` either. `model` still overrides it (a fake in tests, `aiSdkModel(…)`).

`@dudousxd/nestjs-agent-ai-sdk` exports `runAiSdkTurn` and `describeAiSdkModel`, for providers that put their own policy around the AI SDK turn.
