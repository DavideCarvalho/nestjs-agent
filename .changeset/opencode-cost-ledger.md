---
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent-opencode": minor
---

OpenCode turns are priced and recorded like the loop's own: every model call OpenCode makes (each step, the session title, a compaction) goes to the token-usage ledger with `cost_usd` and `cost_source`. OpenCode's own figure wins when it priced the call; a call it priced at 0 is estimated from the library's price (the pricing store, `priceCatalog.prices`, the built-in GovCloud Bedrock table, models.dev), so `priceCatalog` now applies to OpenCode too. `openCode({ cost: 'estimate' })` prefers the library's price whenever it has one.

- Usage counts the whole input side: OpenCode's uncached `tokens.input` plus its cache reads and writes, with `cacheReadTokens` / `cacheWriteTokens` as subsets (was: the uncached input only, cache tokens dropped from the run total).
- The model on the row and the `step-finish` frame is the one OpenCode names for the step (`<providerID>/<model id>`).
- `OpenCodeRunResult.usage` (and the usage on the turn's last message) is summed from the turn's own calls, not read from the store: each milestone carries its share and a durable run journals it, so a run resumed in another process reports the whole run. It now carries `cacheReadTokens`, `cacheWriteTokens` and `reasoningTokens`.
- core: `ModelPriceResolver` (run-time price lookup that seeds a missing row as boot pricing does), `resolveUsageCost`, a `'title'` usage purpose, and more us-gov-west-1 Bedrock prices in the built-in table (Amazon Nova Micro/Lite/Pro, Titan Text Embeddings V2, Meta Llama 3 8B/70B, OpenAI gpt-oss-20b/120b, NVIDIA Nemotron, xAI Grok 4.6), from the AWS Price List.
