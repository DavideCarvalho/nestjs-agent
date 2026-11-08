---
"@dudousxd/nestjs-agent-core": patch
"@dudousxd/nestjs-agent-telescope": patch
"@dudousxd/nestjs-agent-dashboard": patch
"@dudousxd/nestjs-agent-evals": patch
"@dudousxd/nestjs-agent-rag": patch
"@dudousxd/nestjs-agent-rag-media": patch
---

Depend on `@dudousxd/nestjs-diagnostics` `>=0.7.0 <1.0.0` instead of the exact `0.7.2`, so an app on diagnostics 0.8.0 shares one copy (and one channel registry) instead of installing a second one.
