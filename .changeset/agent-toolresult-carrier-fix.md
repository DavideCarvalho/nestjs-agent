---
"@dudousxd/nestjs-agent-core": patch
---

Fix multi-tool agent turns dying with `AI_MissingToolResultsError`. The loop stored a turn's tool
results on a synthetic `role:"user"` carrier message, but every model adapter's `mapMessages` only
reads `toolResults` off `assistant` messages — so the results were dropped and the next model call
saw a tool-call with no matching result. Tool results now ride on the assistant message that made
the calls (matching the store's one-row shape), so the loop can complete a `read → render` turn.
