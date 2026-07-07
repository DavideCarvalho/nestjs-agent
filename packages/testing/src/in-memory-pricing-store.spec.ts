import { describe, expect, it } from 'vitest';
import { InMemoryPricingStore } from './in-memory-pricing-store.js';

describe('InMemoryPricingStore', () => {
  it('upserts a model price and lists it as current', async () => {
    const store = new InMemoryPricingStore();
    await store.upsertModelPrice({ modelId: 'm', inputPricePer1m: 3, outputPricePer1m: 15 });

    const prices = await store.listCurrentPrices();
    expect(prices).toHaveLength(1);
    expect(prices[0]?.modelId).toBe('m');
    expect(prices[0]?.inputPricePer1m).toBe(3);
  });

  it('supersedes the prior row on re-upsert — exactly one current row per model', async () => {
    const store = new InMemoryPricingStore();
    await store.upsertModelPrice({ modelId: 'm', inputPricePer1m: 3, outputPricePer1m: 15 });
    await store.upsertModelPrice({
      modelId: 'm',
      inputPricePer1m: 4,
      outputPricePer1m: 16,
      cacheReadPricePer1m: 0.3,
    });

    const prices = await store.listCurrentPrices();
    expect(prices).toHaveLength(1);
    expect(prices[0]?.modelId).toBe('m');
    expect(prices[0]?.inputPricePer1m).toBe(4);
    expect(prices[0]?.outputPricePer1m).toBe(16);
    expect(prices[0]?.cacheReadPricePer1m).toBe(0.3);
  });

  it('coexists across models', async () => {
    const store = new InMemoryPricingStore();
    await store.upsertModelPrice({ modelId: 'm', inputPricePer1m: 3, outputPricePer1m: 15 });
    await store.upsertModelPrice({ modelId: 'n', inputPricePer1m: 1, outputPricePer1m: 5 });

    const prices = await store.listCurrentPrices();
    expect(prices).toHaveLength(2);
    expect(prices.map((price) => price.modelId).sort()).toEqual(['m', 'n']);
  });
});
