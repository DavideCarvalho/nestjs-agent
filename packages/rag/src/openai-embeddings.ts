import type { EmbeddingProvider } from '@dudousxd/nestjs-agent-core';

/** A non-2xx answer (or a malformed one) from an embeddings or rerank endpoint. */
export class HttpModelError extends Error {
  constructor(
    /** HTTP status; `502` when the endpoint answered 2xx with a body that doesn't fit the contract. */
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpModelError';
  }
}

export interface OpenAiEmbeddingsOptions {
  /** The embedding model id, sent as `model`. */
  model: string;
  /**
   * Base URL up to and including `/v1` — the client posts to `<baseUrl>/embeddings`. Default
   * `https://api.openai.com/v1`. Point it at any OpenAI-compatible server: Azure/OpenRouter/an LLM
   * gateway, Ollama (`http://localhost:11434/v1`), Hugging Face TEI, vLLM, LocalAI, LM Studio…
   */
  baseUrl?: string;
  /** Sent as `Authorization: Bearer <apiKey>` when set. Local servers usually need none. */
  apiKey?: string;
  /** Output width for models that support shortening (`text-embedding-3-*`), sent as `dimensions`. */
  dimensions?: number;
  /**
   * Inputs per request. Default 64. When the server refuses a request for its size (see
   * {@link isBatchTooLarge}) the batch is split in halves and retried, and later requests use the
   * size that worked — so a server whose limit is below this (TEI's `--max-client-batch-size`
   * defaults to 32) costs one refused request, not a failed ingestion.
   */
  batchSize?: number;
  /**
   * Inputs longer than this many characters are truncated before sending, so one oversized chunk
   * doesn't fail a whole batch on the model's context limit. Default 24 000 (≈ 6–8k tokens); set
   * `Infinity` to send inputs as they are.
   */
  maxInputChars?: number;
  /** Extra request headers (an org/project id, a gateway's attribution header). */
  headers?: Record<string, string>;
  /** Per-request timeout. Default 120 000 ms. */
  timeoutMs?: number;
  /** Called with the provider-reported token count of every request — for cost accounting. */
  onUsage?: (tokens: number) => void;
  /**
   * Called when the server refused a batch for its size and it was split — a misconfiguration worth
   * surfacing: raise the server's limit (TEI: `--max-client-batch-size`) or lower `batchSize`.
   */
  onWarn?: (message: string) => void;
  /** `fetch` to use. Default the global one. */
  fetch?: typeof fetch;
}

/**
 * Did the server refuse this request for its **size** — too many inputs (TEI's
 * `--max-client-batch-size`: `batch size 64 > maximum allowed batch size 32`) or too large a
 * payload? Those are fixed by sending fewer inputs per request; anything else (auth, a bad model,
 * one input over the context window) is not, and is rethrown as is.
 */
export function isBatchTooLarge(error: unknown): boolean {
  if (!(error instanceof HttpModelError)) {
    return false;
  }
  if (error.status === 413) {
    return true;
  }
  return (
    (error.status === 400 || error.status === 422) &&
    /batch.?size|too many inputs|maximum allowed batch|payload too large|max.*(inputs|batch)/i.test(
      error.message,
    )
  );
}

/**
 * Batch sizes a server accepted after refusing larger ones, per endpoint URL and model, for the
 * life of the process — so a second provider built for the same server (one per request, say)
 * starts at the size that works instead of re-learning it with a refused request.
 */
const learnedBatchLimits = new Map<string, number>();

/**
 * An {@link EmbeddingProvider} over any OpenAI-compatible `POST /v1/embeddings` endpoint, with no SDK
 * dependency: OpenAI itself, or a gateway/local server speaking the same protocol (TEI, Ollama,
 * vLLM, LocalAI…). For a Vercel AI SDK model use `aiSdkEmbedding` from `-ai-sdk` instead.
 *
 * Batches by {@link OpenAiEmbeddingsOptions.batchSize} — splitting and retrying a batch the server
 * refuses as too large, and remembering the size that worked — restores input order from each item's
 * `index`, and fails loudly (an {@link HttpModelError}) on a non-2xx answer or a vector count that
 * doesn't match the inputs. Empty strings are sent as a single space, since OpenAI rejects them.
 *
 * ```ts
 * const embedder = openAiEmbeddings({ model: 'text-embedding-3-small', apiKey: process.env.OPENAI_API_KEY });
 * const local = openAiEmbeddings({ baseUrl: 'http://tei:8080/v1', model: 'BAAI/bge-m3' });
 * ```
 */
export function openAiEmbeddings(options: OpenAiEmbeddingsOptions): EmbeddingProvider {
  const url = `${(options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '')}/embeddings`;
  const limitKey = `${url} ${options.model}`;
  const configured = Math.max(1, Math.floor(options.batchSize ?? 64));
  let batchSize = Math.min(configured, learnedBatchLimits.get(limitKey) ?? configured);
  const maxInputChars = options.maxInputChars ?? 24_000;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const doFetch = options.fetch ?? fetch;

  const request = async (input: string[]): Promise<number[][]> => {
    const response = await doFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
        ...options.headers,
      },
      body: JSON.stringify({
        model: options.model,
        input,
        ...(options.dimensions !== undefined ? { dimensions: options.dimensions } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new HttpModelError(
        response.status,
        `Embeddings request failed (${response.status}): ${errorMessageOf(body)}`,
      );
    }
    const json = parseJson(body) as {
      data?: { embedding?: unknown; index?: number }[];
      usage?: { prompt_tokens?: number; total_tokens?: number };
    } | null;
    const items = [...(json?.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (items.length !== input.length || !items.every((item) => Array.isArray(item.embedding))) {
      throw new HttpModelError(
        502,
        `Embeddings returned ${items.length} vectors for ${input.length} inputs`,
      );
    }
    const tokens = json?.usage?.total_tokens ?? json?.usage?.prompt_tokens;
    if (typeof tokens === 'number' && Number.isFinite(tokens)) {
      options.onUsage?.(tokens);
    }
    return items.map((item) => item.embedding as number[]);
  };

  // A batch refused for its size is split in halves (recursively) and retried; the smaller size
  // becomes the batch size for every later request to this server and model.
  const requestSplitting = async (input: string[]): Promise<number[][]> => {
    if (input.length > batchSize) {
      // The size was learned while this batch was being split: send the rest at the size that works.
      const vectors: number[][] = [];
      for (let start = 0; start < input.length; start += batchSize) {
        vectors.push(...(await requestSplitting(input.slice(start, start + batchSize))));
      }
      return vectors;
    }
    try {
      return await request(input);
    } catch (error) {
      if (!isBatchTooLarge(error) || input.length <= 1) {
        throw error;
      }
      const half = Math.ceil(input.length / 2);
      if (half < batchSize) {
        batchSize = half;
        learnedBatchLimits.set(limitKey, half);
        options.onWarn?.(
          `embeddings server ${url} refused a batch of ${input.length} inputs (${(error as Error).message}); retrying in batches of ${half}. Raise the server's batch limit (TEI: --max-client-batch-size) or lower batchSize.`,
        );
      }
      return [
        ...(await requestSplitting(input.slice(0, half))),
        ...(await requestSplitting(input.slice(half))),
      ];
    }
  };

  return {
    async embed(texts: string[]): Promise<number[][]> {
      const vectors: number[][] = [];
      for (let start = 0; start < texts.length; ) {
        const input = texts
          .slice(start, start + batchSize)
          .map(
            (text) => (text.length > maxInputChars ? text.slice(0, maxInputChars) : text) || ' ',
          );
        vectors.push(...(await requestSplitting(input)));
        start += input.length;
      }
      return vectors;
    },
  };
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** The human part of an error body: OpenAI's `error.message`, a bare `message`/`error`, or the text. */
export function errorMessageOf(body: string): string {
  const json = parseJson(body) as {
    error?: { message?: unknown } | string;
    message?: unknown;
  } | null;
  const message =
    typeof json?.error === 'string'
      ? json.error
      : (json?.error?.message ?? json?.message ?? undefined);
  return typeof message === 'string' ? message : body.slice(0, 300);
}
