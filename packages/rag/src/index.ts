export { chunkText, type ChunkOptions } from './chunk.js';
export type {
  IndexedDocument,
  LexicalVectorStore,
  VectorRecord,
  VectorSearchOptions,
  VectorStore,
} from './vector-store.js';
export { UnsafeRemovalError, documentIdOf, isLexicalVectorStore } from './vector-store.js';
export type { MetadataPatch } from './metadata-patch.js';
export { applyMetadataPatch } from './metadata-patch.js';
export { MemoryVectorStore } from './memory-vector-store.js';
export {
  PgVectorStore,
  type PgClient,
  type PgVectorStoreOptions,
} from './pg-vector-store.js';
export {
  RedisVectorStore,
  RedisVectorSchemaMismatchError,
  type RedisSearchClient,
  type RedisVectorStoreOptions,
} from './redis-vector-store.js';
export {
  EmbeddingRetriever,
  type EmbeddingRetrieverOptions,
} from './embedding-retriever.js';
export { KeywordRetriever, type KeywordRetrieverOptions } from './keyword-retriever.js';
export { LexicalRetriever } from './lexical-retriever.js';
export { HybridRetriever, type HybridRetrieverOptions } from './hybrid-retriever.js';
export { RerankingRetriever, type RerankingRetrieverOptions } from './reranking-retriever.js';
export { FilteredRetriever } from './filtered-retriever.js';
export {
  chunkDocuments,
  ingestChunks,
  ingestDocuments,
  type ChunkRecord,
  type IngestChunksOptions,
  type IngestDocument,
  type IngestOptions,
} from './ingest.js';
export {
  createRetrievalTool,
  type RetrievalTool,
  type RetrievalToolOptions,
} from './retrieval-tool.js';
