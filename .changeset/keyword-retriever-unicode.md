---
"@dudousxd/nestjs-agent-rag": patch
---

`KeywordRetriever` now tokenizes Unicode text. It uses the same `[\p{L}\p{N}_]+` term class as the Redis lexical path and folds accents, so "manutenção" is one term instead of "manuten" + "o", and a query typed without accents (`manutencao`) still matches. An in-memory index is rebuilt with the new tokenizer the next time you `add` documents.
