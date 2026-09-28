---
'@dudousxd/nestjs-agent-rag': minor
'@dudousxd/nestjs-agent-testing': minor
---

New `openAiEmbeddings` (an `EmbeddingProvider` over any OpenAI-compatible `/v1/embeddings` — OpenAI, gateways, TEI, Ollama, vLLM) and `HttpReranker` (a `Reranker` over Cohere/Jina/Voyage/TEI-style `/rerank`), both dependency-free and throwing `HttpModelError`. `@dudousxd/nestjs-agent-testing` adds `hashedEmbeddings(dimensions)` and a `tokens: 'unicode'` option on `FakeEmbeddingProvider`.
