---
'@dudousxd/nestjs-agent': patch
---

A message queued behind a running turn now runs under `durable: true`. `@dudousxd/nestjs-agent/durable` is its own bundle with its own copy of `ChatQueueService`, and the `agent.run` workflow and the durable runner asked Nest for the queue by that class — optionally — so in an app built from the published package they got `undefined`: the send was accepted (`202`), and when the turn ahead settled nothing started it, paused it or released it. Both now ask by the new `AGENT_CHAT_QUEUE` token, which `AgentModule` provides and which is one value in every bundle. `pnpm check:dist` fails a build where a secondary entry injects a main-entry class by class.
