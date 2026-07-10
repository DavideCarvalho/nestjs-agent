---
"@dudousxd/nestjs-agent-core": patch
"@dudousxd/nestjs-agent-ai-sdk": patch
"@dudousxd/nestjs-agent": patch
"@dudousxd/nestjs-agent-react": patch
---

Stream structured turn events so clients render text, reasoning, and live tool-call cards — not just
text. The sink now carries an NDJSON `AgentStreamEvent` vocabulary (`step-start`/`step-finish`,
`text`, `reasoning`, `tool-input-start`/`-delta`/`-available`, `tool-output`/`-error`): the AI-SDK
adapter emits model parts, the loop emits tool results, the chat controller forwards each line as an
SSE frame, and the React transport maps them back to the AI SDK UI-message chunk protocol. Tool
cards (input streaming → rendered output) and reasoning now appear live via `useAgentChat`, matching
a native `streamText().toUIMessageStream()` while keeping the sink a format-agnostic byte buffer
(durable buffering/replay untouched).

Note: this changes the on-the-wire chat SSE protocol from `{delta}` text frames to
`AgentStreamEvent` frames — upgrade backend (`@dudousxd/nestjs-agent`) and client
(`@dudousxd/nestjs-agent-react`) together.
