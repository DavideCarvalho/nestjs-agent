---
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent-react": minor
"@dudousxd/nestjs-agent": minor
---

Gaps found moving flip-nestjs onto the React client:

- `useAgentChat({ threadId })` reports `isLoadingHistory: true` from the very first render (and on the first render after a thread switch) until the history read settles, so a page shows its skeleton instead of flashing the empty state.
- `GET <base>/tools?agent=*` answers every tool the actor reaches through any agent, each once; `useToolCatalog({ agent: ALL_AGENTS })` reads it (`ALL_AGENTS` from core and react).
- `readOnly` on `useChatTranscript` / `useTranscriptItem` / `<MessageList>`: no approve / reject / answer / skip, edit, fork, regenerate or stop, whatever handlers or backend are in scope — parked approvals and question sets still render. Documents that decision handlers left undefined settle through the in-scope backend.
