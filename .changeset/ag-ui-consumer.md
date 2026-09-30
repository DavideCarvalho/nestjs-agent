---
'@dudousxd/nestjs-agent-react': minor
---

`useAgentChat` can drive an AG-UI 1.0 agent: `agUiChatStream(request, { url })` behind `openChatStream` POSTs a `RunAgentInput` and re-frames the AG-UI answer in this library's stream protocol, so the transcript, tool activity and generative UI render unchanged. `reframeAgUiStream` is the re-framing alone.
