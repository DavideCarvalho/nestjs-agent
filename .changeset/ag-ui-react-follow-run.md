---
"@dudousxd/nestjs-agent-core": patch
"@dudousxd/nestjs-agent": patch
"@dudousxd/nestjs-agent-react": patch
---

AG-UI from React follows the run past an approval or a question, like the native stream.

- `POST <path>/ag-ui` writes the run's own sequence number as each event's SSE `id:` (`agUiEvents({ cursor })`, `agUiSse(event, id)`, `frameSeq`), so a consumer can continue on `chat/:runId/stream?after=<id>` exactly where the AG-UI run ended.
- `agUiChatStream`: an interrupt the chat already shows (approval card, question form) ends the stream without `done`, so the transport re-attaches to the parked run on the native route and what the run does after the person decides streams into the same message. The re-attach cursor is the run's own sequence (before, the client numbered re-framed frames itself, so `?after=` pointed at the wrong frame).
- The `AgUiInterrupt` ui part is written only for interrupts nothing in the stream showed.
- `agora.action-proposal-decision` becomes the transient `data-proposal-decision` part a native text decision answers with.
