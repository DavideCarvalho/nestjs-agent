---
"@dudousxd/nestjs-agent-codegen": minor
---

The generated client now includes the action-proposal routes: `agent.actionProposals.list`, `.approve` and `.reject`, under `/agent/threads/:threadId/action-proposals`. The guard spec that checks codegen against the library's controllers now scans every controller in `@dudousxd/nestjs-agent`, not only `src/controller/`. It now also sees the proposal, resumable-upload and AG-UI routes.
