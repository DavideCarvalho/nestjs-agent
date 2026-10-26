import type { AgentStore, ThreadSettings, ThreadSettingsReader } from '@dudousxd/nestjs-agent-core';

/** What a send reads off the thread it lands on. */
export interface ThreadReads {
  owner(): Promise<string | null>;
  defaultAgent(): Promise<string | null>;
  persona(): Promise<string | null>;
  model(): Promise<string | null>;
}

/**
 * The reads one send makes off `threadId`. A store that projects {@link ThreadSettings} answers all
 * of them with ONE read, taken the first time any is asked; any other store is asked `separately`,
 * field by field.
 */
export function threadReads(
  store: AgentStore,
  threadId: string,
  separately: ThreadReads,
): ThreadReads {
  const projecting = store as Partial<ThreadSettingsReader>;
  if (typeof projecting.threadSettings !== 'function') {
    return separately;
  }
  let settings: Promise<ThreadSettings | null> | undefined;
  const read = () => {
    settings ??= projecting.threadSettings?.(threadId) ?? Promise.resolve(null);
    return settings;
  };
  return {
    owner: async () => (await read())?.actorRef ?? null,
    defaultAgent: async () => (await read())?.defaultAgent ?? null,
    persona: async () => (await read())?.persona ?? null,
    model: async () => (await read())?.model ?? null,
  };
}
