---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent-react': minor
'@dudousxd/nestjs-agent-store-drizzle': minor
'@dudousxd/nestjs-agent-store-mikro-orm': minor
'@dudousxd/nestjs-agent-testing': minor
'@dudousxd/nestjs-agent': patch
---

Reasoning and pushed UI survive a reload.

- core: `StoredMessage` / `AppendMessageInput` gain `reasoning?`, `reasoningMs?` and `ui?: AgentUiComponent[]`; `ModelTurnResult` gains the same three (optional). New `observeTurnFrames` / `withTurnFrames` derive them from the frames a provider streams (thinking time = sum of each burst of consecutive `reasoning` frames), inside the model checkpoint so replays read the journaled values. The loop persists them on each step's assistant message and adds `reasoningMs` to `step-finish`.
- nestjs: the dispatched `llm` step derives them the same way, so they ride its journaled result.
- store-drizzle: `agent_message.reasoning` / `reasoning_ms` / `ui` columns, added to existing databases by `ensureAgentSchema`'s additive pass (ALTERs in the README for drizzle-kit users); copied on fork.
- store-mikro-orm: the same three entity properties (the safe schema update adds them); copied on fork.
- testing: `InMemoryAgentStore` persists them; `EVERY_MESSAGE_FIELD` includes them, so adapter round-trip specs must cover them.
- react: `storedMessageToUiMessage` emits a `reasoning` part before the text and `data-ui` parts for persisted components. The transport stamps `step-finish.reasoningMs` (or the time it watched, as a fallback) on the reasoning part's `providerMetadata.agent.reasoningMs`, and `TranscriptReasoningBlock.durationMs` reads it — the same value live and reloaded. New headless `useElapsed(running)`, `formatElapsed(ms)` and `readReasoningMs(part)`. The registry `ChatReasoning` derives its duration label from them when the host passes none.
