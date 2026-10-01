import type { AgentStore } from '@dudousxd/nestjs-agent-core';

/**
 * A store that can answer a thread's pinned persona on its own, without materializing the thread —
 * probed structurally, like `ThreadDefaultAgentReader`.
 */
export interface ThreadPersonaReader {
  personaForThread(threadId: string): Promise<string | null>;
}

/**
 * The thread's pinned persona: one column when the store projects it ({@link ThreadPersonaReader}),
 * else through the full read.
 */
export async function threadPersona(store: AgentStore, threadId: string): Promise<string | null> {
  const projecting = store as Partial<ThreadPersonaReader>;
  if (typeof projecting.personaForThread === 'function') {
    return projecting.personaForThread(threadId);
  }
  return (await store.getThread(threadId))?.persona ?? null;
}
