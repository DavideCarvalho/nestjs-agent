import { EntityRepository } from '@mikro-orm/core';
import { describe, expect, it } from 'vitest';
import * as rootBarrel from '../index';

const REPOSITORY_NAMES = [
  'AgentThreadRepository',
  'AgentMessageRepository',
  'AgentToolCallRepository',
  'AgentTokenUsageRepository',
  'AgentModelPricingRepository',
  'AgentRunRepository',
  'RagIngestionLogRepository',
] as const;

describe('custom repositories', () => {
  // A barrel that re-exports a class with `export type` type-checks and builds green, then hands
  // the host `undefined` at runtime — so the assertion has to be a runtime one, off the root
  // barrel, which is the only entry point the package publishes.
  it.each(REPOSITORY_NAMES)('exports %s as a runtime value from the package root', (name) => {
    const exported = (rootBarrel as Record<string, unknown>)[name];
    expect(exported).toBeDefined();
    expect(typeof exported).toBe('function');
    expect(Object.getPrototypeOf(exported as object)).toBe(EntityRepository);
  });
});
