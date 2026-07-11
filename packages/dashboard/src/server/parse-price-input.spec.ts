import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { parsePriceInput } from './parse-price-input';

describe('parsePriceInput', () => {
  it('accepts the minimal required shape', () => {
    expect(
      parsePriceInput({ modelId: 'gpt-4o', inputPricePer1m: 2.5, outputPricePer1m: 10 }),
    ).toEqual({ modelId: 'gpt-4o', inputPricePer1m: 2.5, outputPricePer1m: 10 });
  });

  it('carries through optional cache prices when present', () => {
    expect(
      parsePriceInput({
        modelId: 'gpt-4o',
        inputPricePer1m: 2.5,
        outputPricePer1m: 10,
        cacheWritePricePer1m: 3.1,
        cacheReadPricePer1m: 0.25,
      }),
    ).toEqual({
      modelId: 'gpt-4o',
      inputPricePer1m: 2.5,
      outputPricePer1m: 10,
      cacheWritePricePer1m: 3.1,
      cacheReadPricePer1m: 0.25,
    });
  });

  it('rejects a non-object body', () => {
    expect(() => parsePriceInput(null)).toThrow(BadRequestException);
    expect(() => parsePriceInput('gpt-4o')).toThrow(BadRequestException);
    expect(() => parsePriceInput(undefined)).toThrow(BadRequestException);
  });

  it('rejects a missing or empty modelId', () => {
    expect(() => parsePriceInput({ inputPricePer1m: 1, outputPricePer1m: 1 })).toThrow(
      BadRequestException,
    );
    expect(() =>
      parsePriceInput({ modelId: '  ', inputPricePer1m: 1, outputPricePer1m: 1 }),
    ).toThrow(BadRequestException);
  });

  it('rejects a non-finite or negative price', () => {
    expect(() =>
      parsePriceInput({ modelId: 'm', inputPricePer1m: -1, outputPricePer1m: 1 }),
    ).toThrow(BadRequestException);
    expect(() =>
      parsePriceInput({ modelId: 'm', inputPricePer1m: Number.NaN, outputPricePer1m: 1 }),
    ).toThrow(BadRequestException);
    expect(() =>
      parsePriceInput({ modelId: 'm', inputPricePer1m: 1, outputPricePer1m: '1' }),
    ).toThrow(BadRequestException);
  });

  it('rejects an invalid optional cache price', () => {
    expect(() =>
      parsePriceInput({
        modelId: 'm',
        inputPricePer1m: 1,
        outputPricePer1m: 1,
        cacheWritePricePer1m: -1,
      }),
    ).toThrow(BadRequestException);
  });
});
