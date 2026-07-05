import type { DataProvider, ExtensionContext } from '@dudousxd/nestjs-telescope';
import { TELESCOPE_STORAGE } from '@dudousxd/nestjs-telescope';

interface AgentEntryContent {
  event: string;
  runId?: string;
  threadId?: string;
  toolName?: string;
  toolType?: string;
  status?: string;
  steps?: number;
  inputTokens?: number;
  outputTokens?: number;
}

interface StorageEntry {
  content?: AgentEntryContent;
  createdAt?: Date;
}

async function fetchEntries(ctx: ExtensionContext): Promise<StorageEntry[]> {
  const storage = ctx.moduleRef.get(TELESCOPE_STORAGE, { strict: false }) as {
    get(query: { type?: string; limit?: number }): Promise<{ data: StorageEntry[] }>;
  };
  const page = await storage.get({ type: 'agent', limit: 5_000 });
  return page.data;
}

function ofEvent(entries: StorageEntry[], event: string): StorageEntry[] {
  return entries.filter((entry) => entry.content?.event === event);
}

/** stat → total agent runs (run.finished entries). */
export function agentRunsProvider(): DataProvider {
  return {
    name: 'agent.runs',
    async resolve(_query, ctx) {
      const finished = ofEvent(await fetchEntries(ctx), 'run.finished');
      return { value: finished.length };
    },
  };
}

/** stat → total tokens across all finished runs. */
export function agentTokensProvider(): DataProvider {
  return {
    name: 'agent.tokens',
    async resolve(_query, ctx) {
      const finished = ofEvent(await fetchEntries(ctx), 'run.finished');
      const value = finished.reduce(
        (sum, entry) =>
          sum + (entry.content?.inputTokens ?? 0) + (entry.content?.outputTokens ?? 0),
        0,
      );
      return { value };
    },
  };
}

/** table → recent tool calls. */
export function agentToolsProvider(): DataProvider {
  return {
    name: 'agent.tools',
    async resolve(_query, ctx) {
      const calls = ofEvent(await fetchEntries(ctx), 'tool-call')
        .slice(-50)
        .reverse()
        .map((entry) => ({
          toolName: entry.content?.toolName ?? '',
          toolType: entry.content?.toolType ?? '',
          status: entry.content?.status ?? '',
          runId: entry.content?.runId ?? '',
        }));
      return { rows: calls };
    },
  };
}

/** breakdown → tool-call status distribution. */
export function agentToolStatusProvider(): DataProvider {
  return {
    name: 'agent.toolStatus',
    async resolve(_query, ctx) {
      const calls = ofEvent(await fetchEntries(ctx), 'tool-call');
      const counts = new Map<string, number>();
      for (const call of calls) {
        const status = call.content?.status ?? 'unknown';
        counts.set(status, (counts.get(status) ?? 0) + 1);
      }
      return { segments: [...counts.entries()].map(([label, value]) => ({ label, value })) };
    },
  };
}
