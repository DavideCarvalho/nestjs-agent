---
"@dudousxd/nestjs-agent-ai-sdk": patch
"@dudousxd/nestjs-agent-channels": patch
"@dudousxd/nestjs-agent-codegen": patch
"@dudousxd/nestjs-agent-core": patch
"@dudousxd/nestjs-agent-dashboard": patch
"@dudousxd/nestjs-agent-data": patch
"@dudousxd/nestjs-agent-evals": patch
"@dudousxd/nestjs-agent-mcp-server": patch
"@dudousxd/nestjs-agent-mcp": patch
"@dudousxd/nestjs-agent": patch
"@dudousxd/nestjs-agent-opencode": patch
"@dudousxd/nestjs-agent-poppy": patch
"@dudousxd/nestjs-agent-rag-media": patch
"@dudousxd/nestjs-agent-rag": patch
"@dudousxd/nestjs-agent-react": patch
"@dudousxd/nestjs-agent-store-drizzle": patch
"@dudousxd/nestjs-agent-store-mikro-orm": patch
"@dudousxd/nestjs-agent-telescope": patch
"@dudousxd/nestjs-agent-testing": patch
"@dudousxd/nestjs-agent-transport-redis": patch
---

Fix packages that could be published without files their `exports` point to. The two tsup passes (ESM, CJS) no longer each clean `dist/` while running at the same time; `dist/` is cleaned once before the build. A new `check:exports` step (also `prepack`) fails the release if any `exports`/`main`/`types` path is missing.
