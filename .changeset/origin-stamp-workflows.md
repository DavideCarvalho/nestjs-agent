---
"@dudousxd/nestjs-agent-channels": patch
"@dudousxd/nestjs-agent": patch
---

Stamp durable runs with the package that registered them, so the durable console's ORIGIN facet
separates library runs from the app's own.

- `@dudousxd/nestjs-agent-channels`: the `agora.channel.job` / `agora.channel.timer` workflows are
  registered with a bare `engine.register`, so nothing derived their origin — they now pass
  `origin: CHANNELS_ORIGIN` (`'@dudousxd/nestjs-agent-channels'`, exported).
- `@dudousxd/nestjs-agent`: `agent.run` is a `@Workflow` class whose origin `@dudousxd/nestjs-durable`
  derives from its declaring file — but only from 0.40.0 on. The peer range is raised to
  `@dudousxd/nestjs-durable >=0.40.0` / `@dudousxd/nestjs-durable-core >=0.63.0` so every supported
  install actually stamps it.
