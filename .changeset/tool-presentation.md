---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent': minor
'@dudousxd/nestjs-agent-react': minor
'@dudousxd/nestjs-agent-codegen': minor
---

Tool presentation declared on the server, and a headless tool-activity model on the client.

- core: `ToolPresentation` (`label`, `running`/`done` templates over the call's input, `icon`, `detail`, `tone`, `confirm: { title, verb, detail? }`, `result` view over the output), `ToolResultView` (`metrics` / `table` / `log` / `note` / `elsewhere`), `ToolCatalogEntry`; `ToolSpec.presentation` (never shown to the model); `ToolRegistry.visibleSpecs` — whole specs behind the same gates as `definitionsFor`.
- nestjs: `@AiTool({ presentation })`; `GET /agent/tools?agent=` returns `ToolCatalogEntry[]` for the tools the caller can reach through that agent (default agent when omitted, `404` for an unknown one).
- react: `AgentClient.listTools`, `useToolCatalog({ client, agent? })` (one shared request per client + agent), `phraseFor` / `fillTemplate` / `readPath` / `toolCatalogFrom`, `resolveResultView` / `inferResultView`, `toolCallState` / `correctedCallIds` / `isActionCall` / `describeToolCall`, and `groupToolActivity` (group by label or any key, counts, worst status, nested-call counts or expansion, corrected-failure hiding). `useChatTranscript({ toolCatalog })` gives every tool call a `description` and every tool block an `activity` grouping.
- codegen: `GET /agent/tools` in the generated client; `StoredMessage` mirror gains `reasoning`, `reasoningMs`, `ui`.
