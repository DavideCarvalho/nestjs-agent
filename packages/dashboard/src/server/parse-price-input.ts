import type { ModelPriceInput } from '@dudousxd/nestjs-agent-core';
import { BadRequestException } from '@nestjs/common';

/**
 * Minimal shape guard for a `POST <api>/pricing` body — rejects junk before it reaches
 * `AgentPricingStore.upsertModelPrice`. Not a full schema validator (the store adapter owns real
 * constraints, e.g. uniqueness); this only checks the wire shape core's `ModelPriceInput` requires.
 */
export function parsePriceInput(body: unknown): ModelPriceInput {
  if (typeof body !== 'object' || body === null) {
    throw new BadRequestException('Expected a JSON object body.');
  }
  const { modelId, inputPricePer1m, outputPricePer1m, cacheWritePricePer1m, cacheReadPricePer1m } =
    body as Record<string, unknown>;

  if (typeof modelId !== 'string' || modelId.trim().length === 0) {
    throw new BadRequestException('"modelId" must be a non-empty string.');
  }
  if (!isFiniteNonNegative(inputPricePer1m)) {
    throw new BadRequestException('"inputPricePer1m" must be a non-negative number.');
  }
  if (!isFiniteNonNegative(outputPricePer1m)) {
    throw new BadRequestException('"outputPricePer1m" must be a non-negative number.');
  }
  if (cacheWritePricePer1m !== undefined && !isFiniteNonNegative(cacheWritePricePer1m)) {
    throw new BadRequestException(
      '"cacheWritePricePer1m" must be a non-negative number when present.',
    );
  }
  if (cacheReadPricePer1m !== undefined && !isFiniteNonNegative(cacheReadPricePer1m)) {
    throw new BadRequestException(
      '"cacheReadPricePer1m" must be a non-negative number when present.',
    );
  }

  return {
    modelId,
    inputPricePer1m,
    outputPricePer1m,
    ...(cacheWritePricePer1m !== undefined ? { cacheWritePricePer1m } : {}),
    ...(cacheReadPricePer1m !== undefined ? { cacheReadPricePer1m } : {}),
  };
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
