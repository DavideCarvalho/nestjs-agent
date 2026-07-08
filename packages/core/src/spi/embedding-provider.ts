/**
 * Turns text into embedding vectors — the sibling of {@link import('./model-provider.js').ModelProvider}
 * for the retrieval side. Batched (`texts` → one vector each, same order) so ingestion can embed many
 * chunks per call. `@dudousxd/nestjs-agent-ai-sdk` implements it over the Vercel AI SDK `embedMany`;
 * `@dudousxd/nestjs-agent-testing` ships a deterministic fake for offline tests.
 */
export interface EmbeddingProvider {
  /** Embed each input string; returns one vector per input, in the same order. */
  embed(texts: string[]): Promise<number[][]>;
}
