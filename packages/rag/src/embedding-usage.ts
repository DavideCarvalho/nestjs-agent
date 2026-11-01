import type { EmbeddingProvider } from '@dudousxd/nestjs-agent-core';

/** What one embedding call consumed: the whole batch, not per text. */
export interface EmbeddingUsage {
  inputTokens: number;
  /** The model the provider reported, needed to estimate a cost. */
  modelId?: string;
}

export interface EmbeddingResult {
  vectors: number[][];
  usage?: EmbeddingUsage;
}

/** An {@link EmbeddingProvider} that can also say what a call cost. `openAiEmbeddings` is one. */
export interface UsageReportingEmbeddingProvider extends EmbeddingProvider {
  embedWithUsage(texts: string[]): Promise<EmbeddingResult>;
}

/** Calls `embedWithUsage` when the provider has it, otherwise `embed` with no usage. */
export async function embedCountingUsage(
  provider: EmbeddingProvider,
  texts: string[],
): Promise<EmbeddingResult> {
  const reporting = provider as Partial<UsageReportingEmbeddingProvider>;
  return typeof reporting.embedWithUsage === 'function'
    ? reporting.embedWithUsage(texts)
    : { vectors: await provider.embed(texts) };
}
