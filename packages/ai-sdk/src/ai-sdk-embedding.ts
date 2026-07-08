import type { EmbeddingProvider } from '@dudousxd/nestjs-agent-core';
import { type EmbeddingModel, embedMany } from 'ai';

/**
 * Adapt a Vercel AI SDK `EmbeddingModel` to the core {@link EmbeddingProvider} SPI — the retrieval-side
 * sibling of {@link import('./ai-sdk-model.js').aiSdkModel}. Batches through `embedMany`, so ingestion
 * embeds many chunks in one call; returns one vector per input, in order.
 *
 * ```ts
 * const embedder = aiSdkEmbedding(openai.embedding('text-embedding-3-small'));
 * ```
 */
export function aiSdkEmbedding(model: EmbeddingModel): EmbeddingProvider {
  return {
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) {
        return [];
      }
      const { embeddings } = await embedMany({ model, values: texts });
      return embeddings;
    },
  };
}
