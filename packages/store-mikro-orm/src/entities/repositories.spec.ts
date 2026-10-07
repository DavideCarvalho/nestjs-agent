import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EntityRepository } from '@mikro-orm/core';
import { describe, expect, it } from 'vitest';
import * as rootBarrel from '../index';

const REPOSITORY_NAMES = [
  'AgentActionProposalRepository',
  'AgentThreadRepository',
  'AgentMessageRepository',
  'AgentToolCallRepository',
  'AgentTokenUsageRepository',
  'AgentModelPricingRepository',
  'AgentRunRepository',
  'RagIngestionLogRepository',
  'AgentConfirmTokenRepository',
  'AgentChannelStateRepository',
  'AgentMemoryRepository',
  'AgentStreamFrameRepository',
  'AgentQueuedMessageRepository',
] as const;

/** Every `export class …Repository` the entity files declare, read off disk. */
function declaredRepositories(): string[] {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  return readdirSync(dir)
    .filter((name) => name.endsWith('.entity.ts'))
    .flatMap((name) =>
      [...readFileSync(join(dir, name), 'utf8').matchAll(/export class (\w+Repository)\b/g)].map(
        (match) => match[1] as string,
      ),
    )
    .sort();
}

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

  it('covers every repository an entity file declares', () => {
    expect([...REPOSITORY_NAMES].sort()).toEqual(declaredRepositories());
  });
});
