import { useChat } from '@ai-sdk/react';
import type { ThreadDetail, ThreadSummary } from '@dudousxd/nestjs-agent-core';
import type { UIMessage } from 'ai';
import { useCallback, useMemo, useRef, useState } from 'react';
import { AgentChatTransport, type AgentStreamMeta } from './agent-chat-transport.js';
import { AgentClient, type PersonaCatalogEntry, type QuotaToday } from './client.js';

export interface UseAgentChatOptions {
  /** Origin + base path, e.g. `https://api.example.com`. Defaults to `''`. */
  baseUrl?: string;
  /** Static headers merged into every request. */
  headers?: Record<string, string>;
  /** Resolved per request — for short-lived bearer tokens. */
  getHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Forwarded to fetch so cookie auth/impersonation works. */
  credentials?: RequestCredentials;
  /** Injectable for tests / non-browser runtimes. */
  fetch?: typeof fetch;
  /** Reuse an existing client instead of constructing one. */
  client?: AgentClient;
  /** Named agent to run each turn. */
  agent?: string;
  /** Thread this chat is bound to. Omitted → backend creates one on send. */
  threadId?: string;
  /** Persisted history to seed `useChat` with (consumed on mount only). */
  initialMessages?: UIMessage[];
  /**
   * True when the thread row reports a non-null `activeStreamId` — i.e.
   * there's a buffered stream to reconnect to. Gates the SDK's `resume`
   * so a normal mount never fires a doomed resume GET.
   */
  hasActiveStream?: boolean;
  /** Run id of the buffered stream to resume (the thread's activeStreamId). */
  activeStreamId?: string;
  /** Active persona id sent on every turn. */
  persona?: string;
  /** Read at every send to capture a page snapshot for the page-assistant. */
  getPageContext?: () => Record<string, unknown> | null;
  /** Fired after each streamed turn finishes (e.g. to refetch the sidebar). */
  onFinish?: () => void;
}

interface AddToolResultArgs {
  tool: string;
  toolCallId: string;
  output: unknown;
}

/**
 * Generalized `useChat` wiring for the nestjs-agent backend. Wraps the
 * AI SDK v6 hook with `AgentChatTransport`, plus thread list/load/delete/
 * fork, persona catalog, quota, cancel, and HITL approve/reject — all
 * driven through `AgentClient`. Mirrors flip's `useAdminChat`, generalized.
 */
export function useAgentChat(options: UseAgentChatOptions) {
  const latest = useRef(options);
  latest.current = options;

  const [runId, setRunId] = useState<string | undefined>(options.activeStreamId);
  const runIdRef = useRef<string | undefined>(runId);
  runIdRef.current = runId;

  const client = useMemo(() => {
    if (options.client) return options.client;
    return new AgentClient({
      ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
      ...(options.credentials !== undefined ? { credentials: options.credentials } : {}),
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      getHeaders: async () => mergeHeaders(latest.current),
    });
    // Identity-stable: per-render config is read through `latest`.
    // biome-ignore lint/correctness/useExhaustiveDependencies: stable by design
  }, []);

  const transport = useMemo(() => {
    function onMeta(meta: AgentStreamMeta): void {
      setRunId(meta.runId);
    }
    return new AgentChatTransport({
      ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
      ...(options.credentials !== undefined ? { credentials: options.credentials } : {}),
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      ...(options.agent !== undefined ? { agent: options.agent } : {}),
      getHeaders: async () => mergeHeaders(latest.current),
      getBody: () => {
        const current = latest.current;
        const pageContext = current.getPageContext?.() ?? null;
        return {
          ...(current.threadId !== undefined ? { threadId: current.threadId } : {}),
          ...(current.persona !== undefined ? { persona: current.persona } : {}),
          ...(pageContext ? { pageContext } : {}),
        };
      },
      getResumeRunId: () => {
        const current = latest.current;
        return current.hasActiveStream === true ? current.activeStreamId : undefined;
      },
      onMeta,
    });
    // biome-ignore lint/correctness/useExhaustiveDependencies: stable by design
  }, []);

  const chat = useChat({
    transport,
    resume: options.threadId !== undefined && options.hasActiveStream === true,
    ...(options.threadId !== undefined ? { id: options.threadId } : {}),
    ...(options.initialMessages !== undefined ? { messages: options.initialMessages } : {}),
    onFinish: () => {
      latest.current.onFinish?.();
    },
  });

  const chatRef = useRef(chat);
  chatRef.current = chat;

  // chat.addToolResult is generic over the backend's tool registry, which
  // we don't statically type here. Expose a string-keyed adapter and narrow
  // once at the SDK boundary. (Documented cast — the only one in this file.)
  type SdkAddToolResult = typeof chat.addToolResult;
  type SdkArgs = Parameters<SdkAddToolResult>[0];
  const addToolResult = useCallback(
    ({ tool, toolCallId, output }: AddToolResultArgs) =>
      chatRef.current.addToolResult({
        tool,
        toolCallId,
        output,
      } as unknown as SdkArgs),
    [],
  );

  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [personaCatalog, setPersonaCatalog] = useState<PersonaCatalogEntry[]>([]);
  const [quota, setQuota] = useState<QuotaToday | null>(null);

  const loadThreads = useCallback(async (): Promise<ThreadSummary[]> => {
    const list = await client.listThreads();
    setThreads(list);
    return list;
  }, [client]);

  const loadThread = useCallback(
    (id: string): Promise<ThreadDetail> => client.getThread(id),
    [client],
  );

  const deleteThread = useCallback(
    async (id: string): Promise<void> => {
      await client.deleteThread(id);
      setThreads((current) => current.filter((thread) => thread.id !== id));
    },
    [client],
  );

  const forkThread = useCallback(
    (threadId: string, messageId: string): Promise<ThreadSummary> =>
      client.forkFromMessage(threadId, messageId),
    [client],
  );

  const loadPersonaCatalog = useCallback(async (): Promise<PersonaCatalogEntry[]> => {
    const catalog = await client.getPersonaCatalog();
    setPersonaCatalog(catalog);
    return catalog;
  }, [client]);

  const loadQuota = useCallback(async (): Promise<QuotaToday> => {
    const today = await client.getQuotaToday();
    setQuota(today);
    return today;
  }, [client]);

  const cancel = useCallback(async (): Promise<void> => {
    // Close the SSE on the client first so the UI flips out of streaming,
    // then hard-abort server-side (a late terminal step can outlive the
    // connection close alone).
    chatRef.current.stop();
    const activeRunId = runIdRef.current;
    if (activeRunId) {
      try {
        await client.cancelStream(activeRunId);
      } catch {
        /* best-effort — the SDK stop already flipped the UI */
      }
    }
  }, [client]);

  const approve = useCallback(
    async ({ toolCallId }: { toolCallId: string }): Promise<void> => {
      const activeRunId = runIdRef.current;
      if (!activeRunId) throw new Error('No active run to approve');
      await client.approveToolCall({ runId: activeRunId, toolCallId });
    },
    [client],
  );

  const reject = useCallback(
    async ({
      toolCallId,
      reason,
    }: {
      toolCallId: string;
      reason?: string;
    }): Promise<void> => {
      const activeRunId = runIdRef.current;
      if (!activeRunId) throw new Error('No active run to reject');
      await client.rejectToolCall({
        runId: activeRunId,
        toolCallId,
        ...(reason !== undefined ? { reason } : {}),
      });
    },
    [client],
  );

  return {
    ...chat,
    addToolResult,
    runId,
    client,
    threads,
    loadThreads,
    loadThread,
    deleteThread,
    forkThread,
    personaCatalog,
    loadPersonaCatalog,
    quota,
    loadQuota,
    cancel,
    approve,
    reject,
  };
}

async function mergeHeaders(options: UseAgentChatOptions): Promise<Record<string, string>> {
  const dynamic = (await options.getHeaders?.()) ?? {};
  return { ...options.headers, ...dynamic };
}
