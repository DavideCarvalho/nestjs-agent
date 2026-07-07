---
"@dudousxd/nestjs-agent-ai-sdk": minor
"@dudousxd/nestjs-agent-react": minor
---

Upgrade to Vercel AI SDK v7.

- `@dudousxd/nestjs-agent-ai-sdk` now peer-depends on `ai@^7` (was `^6`). The adapter migrated to the v7 result surface: it reads `result.stream` (renamed from `fullStream`), passes `instructions` (renamed from `system`), and takes `modelId` / provider cost from `result.finalStep` (the top-level `response` / `providerMetadata` accessors are deprecated in v7). Usage mapping drops the removed `cachedInputTokens` / `reasoningTokens` flat aliases and reads the `inputTokenDetails` / `outputTokenDetails` breakdowns.
- `@dudousxd/nestjs-agent-react` now peer-depends on `@ai-sdk/react@^4` and `ai@^7` (were `^3` / `^6`).

To upgrade, bump your app's `ai` to `^7` (and `@ai-sdk/react` to `^4` if you use the React package).
