---
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent": minor
"@dudousxd/nestjs-agent-react": minor
"@dudousxd/nestjs-agent-channels": patch
---

Generative UI: draw a `ui__render` tree while the model writes it.

- **`streaming: 'partial'`** (tree mode, on `genuiTools` and `AgentGenuiModule`). The server parses the streaming `ui__render` arguments and pushes the tree so far as `ui` frames marked `partial: true`, under the id the final push replaces (`<toolCallId>:ui:0`). Previews are throttled (`streamingThrottleMs`, default 100 ms, and only when changed), never validated, never persisted, carry no `fallbackText` and are skipped by text channels; a turn whose client cannot draw the tree gets none. Only the final tree goes through the catalog; a preview the call does not replace (an invalid tree, a text fallback) is withdrawn with a partial frame whose `props` are `{}`. The previews a step showed ride its journaled result (inline, and the durable runner's dispatched llm step), so a replay withdraws the same ones. AG-UI sends the previews as repeated `agora.ui` events with the same id. The default stays `streaming: 'complete'`, since renderers written for validated props would otherwise receive half-written ones. Wire format identical to `@adonis-agora/agent`'s.
- **Per component:** `defineComponent({ …, streaming: 'complete' })` holds a component back while its subtree is written — the node is a `{ held: true, props: {} }` placeholder until it closes — and `streaming: 'partial'` opts one in.
- **Stable nodes:** every node of a partial tree carries its position as `id` (`root`, `root.0`, …), the same rule that names the final tree's nodes, and `incomplete: true` while it is being written.
- **React:** `<GenerativeUI>` renders partial trees without remounting nodes, skips prop validation for incomplete nodes, exposes `useGenuiNode()` (`{ id, type, incomplete, held }`) for skeletons, and draws `placeholder` (new prop on `<GenerativeUI>` / `<GenuiProvider>` / `genui` on `<AgentProvider>`, default `loading`) for held nodes. The transport carries `partial` on the `data-ui` part; the transcript drops withdrawn previews and those whose call settled without replacing them; a json-render spec leaves held nodes out.
- **Tool SPI:** `ToolHandler.previewInput(scope)` lets any tool preview its streaming input (`ToolRegistry.previewInput`, `previewToolInputs`, `registryInputPreviews`); `parsePartialJson` is exported. `AgentUiComponent.partial` joins the stream vocabulary.
- **Channels:** a text channel never sends a preview, only the final component or its fallback text.
