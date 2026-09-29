---
'@dudousxd/nestjs-agent-rag': minor
---

PageIndex-style tree navigation retrieval for long structured documents ("vectorless", reasoning-based: a table-of-contents tree per document, navigated by an LLM). In a 149-question benchmark it beat hybrid dense+lexical search by +24 points on long GovCon regulations and +30 on FinanceBench 10-Ks, with no gain on short notes — so it is built to sit behind the existing search, not replace it.

- `buildDocumentTree` / `indexDocumentTree`: structure from the PDF outline, section titles or detected headings (markdown, `PART 52`, `Item 7.`, `52.236–5 …`; running headers and contents listings dropped) before any LLM; LLM structuring only for documents with no usable outline; page groups as the never-failing fallback. Hard per-document budget (calls, input/output tokens, timeout) checked before every call, no retries; top-down summaries within it. Deterministic and fingerprinted: unchanged documents cost no LLM call, changed ones re-summarize only changed sections. `minUnits`/`minChars` threshold (default 20 pages / 60k chars).
- `DocumentTreeStore` SPI with `MemoryDocumentTreeStore` and `PgDocumentTreeStore` (same clients as `PgVectorStore`, Drizzle included; `schemaStatements()`/`ensureSchema()`; filters with the vector stores' semantics).
- `TreeNavigationRetriever`: single-pass over small outlines, a bounded beam over large ones, per-navigation budget, passages with `documentId`/`nodeId`/pages/path metadata and an auditable trail of every step's choices and reasoning. Implements `Retriever`.
- `TwoStageRetriever`: first stage picks documents; the top long ones (those with a tree) are navigated, short ones keep their chunks.
- `createNavigateDocumentTool`: the `navigate_document({ documentId, question })` agent tool, with a per-call access filter.
- `TreeLlm` adapters: `openAiChatTreeLlm`, `treeLlmFromModelProvider`, `cachedTreeLlm`, and the deterministic `keywordTreeLlm` for tests.

Credits: PageIndex (Vectify AI, MIT) — see the package NOTICE.
