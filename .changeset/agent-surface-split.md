---
'@dudousxd/nestjs-agent': minor
---

Add `AgentModuleOptions.surface: 'http' | 'engine' | 'both'` (default `'both'`, zero behavior
change when omitted) so an API pod and a worker pod can each load `AgentModule` without either
one doing the other's job:

- `'engine'` mounts NO controllers — the worker fleet's pod loads the `agent.run` durable workflow
  and its dispatched steps (`AgentRunSteps.llm`/`.tool`) exactly as `'both'` does today.
- `'http'` mounts every controller (chat/threads/tool-call/quota/agents/attachments), fully
  functional, but never registers the dispatched-step handlers — an API pod that also registered
  them subscribed their queues and ran LLM/tool work meant for the worker fleet (the durable
  skew-protection crash-loop this option fixes). HITL signal delivery (`workflows.signal`) and
  starting a run both keep working from the http side.

`AgentDurableModule.forRoot({ surface })` mirrors the same option (it can't be inferred from
`AgentModule`'s own options — Nest builds a module's provider list before any injected value
exists to read); the `agentDurable(options)` one-call helper threads a single `surface` to both.
