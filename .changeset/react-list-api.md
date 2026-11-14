---
'@dudousxd/nestjs-agent-react': minor
---

`AgentClient` speaks the agent's new list wire (`@dudousxd/nestjs-agent` 4.0): `listThreads`, `listSkills`, `listTools`, `listModels` and `listAgents` read `{ data }` answers and send `filter[threadId]` / `filter[agent]` / `filter[persona]` instead of the flat params. `listActionProposals` follows `meta.nextCursor` across cursor pages instead of the `X-Action-Proposals-Next` header. `listThreads({ size })` can size the list. Method signatures and return types are unchanged, so hooks and components need no change. This client needs `@dudousxd/nestjs-agent` 4.0 or later on the server.
