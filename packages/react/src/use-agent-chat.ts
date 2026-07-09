import { useChat } from '@ai-sdk/react';
import type { ThreadDetail, ThreadSummary } from '@dudousxd/nestjs-agent-core';
import type { UIMessage } from 'ai';
import { useCallback, useMemo, useRef, useState } from 'react';
import { AgentChatTransport, type AgentStreamMeta } from './agent-chat-transport.js';
import { AgentClient, type QuotaToday } from './client.js';

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
   * Run id of a buffered stream to reconnect to on mount — wire this to the thread's
   * `activeStreamId`. Its presence both gates the SDK's `resume` and names the run, so a normal
   * mount (no id) never fires a doomed resume GET. Omitted → no resume.
   */
  resumeRunId?: string;
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
 * AI SDK v7 hook with `AgentChatTransport`, plus thread list/load/delete/
 * fork, quota, cancel, and HITL approve/reject — all driven through
 * `AgentClient`. Mirrors flip's `useAdminChat`, generalized.
 */
export function useAgentChat(options: UseAgentChatOptions) {
  const latest = useRef(options);
  latest.current = options;

  const [runId, setRunId] = useState<string | undefined>(options.resumeRunId);
  const runIdRef = useRef<string | undefined>(runId);
  runIdRef.current = runId;

  // One-shot flag read (and cleared) by the transport's getBody so the next send carries
  // `regenerate: true` — telling the backend to re-run the last exchange instead of appending.
  const regenerateNext = useRef(false);

  // Identity-stable: per-render config is read through `latest`.
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable by design
  const client = useMemo(() => {
    if (options.client) return options.client;
    return new AgentClient({
      ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
      ...(options.credentials !== undefined ? { credentials: options.credentials } : {}),
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      getHeaders: async () => mergeHeaders(latest.current),
    });
  }, []);

  // Identity-stable: per-render config is read through `latest`.
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable by design
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
        const regenerate = regenerateNext.current;
        regenerateNext.current = false;
        return {
          ...(current.threadId !== undefined ? { threadId: current.threadId } : {}),
          ...(pageContext ? { pageContext } : {}),
          ...(regenerate ? { regenerate: true } : {}),
        };
      },
      getResumeRunId: () => latest.current.resumeRunId,
      onMeta,
    });
  }, []);

  const chat = useChat({
    transport,
    resume: options.resumeRunId !== undefined,
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

  const renameThread = useCallback(
    async (id: string, title: string): Promise<void> => {
      await client.renameThread(id, title);
      setThreads((current) =>
        current.map((thread) => (thread.id === id ? { ...thread, title } : thread)),
      );
    },
    [client],
  );

  // A promoted thread was transient — invisible to `listThreads` — so refetch to bring it into view.
  const promoteThread = useCallback(
    async (id: string): Promise<void> => {
      await client.promoteThread(id);
      await loadThreads();
    },
    [client, loadThreads],
  );

  const truncateFromMessage = useCallback(
    (threadId: string, messageId: string): Promise<void> =>
      client.truncateFromMessage(threadId, messageId).then(() => undefined),
    [client],
  );

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

  // Approve / reject route by tool-call id alone — the server derives the run awaiting it (which is
  // the sub-agent's own run when the pending call belongs to a delegated agent), so no runId is sent.
  const approve = useCallback(
    async ({ toolCallId }: { toolCallId: string }): Promise<void> => {
      await client.approveToolCall({ toolCallId });
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
      await client.rejectToolCall({
        toolCallId,
        ...(reason !== undefined ? { reason } : {}),
      });
    },
    [client],
  );

  // Re-run the last exchange: flag the next request as a regenerate (so the backend truncates and
  // re-answers instead of appending) and let the SDK re-issue it, dropping the last assistant turn.
  const regenerate = useCallback((): void => {
    regenerateNext.current = true;
    void chatRef.current.regenerate();
  }, []);

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
    renameThread,
    promoteThread,
    truncateFromMessage,
    quota,
    loadQuota,
    cancel,
    approve,
    reject,
    regenerate,
  };
}

async function mergeHeaders(options: UseAgentChatOptions): Promise<Record<string, string>> {
  const dynamic = (await options.getHeaders?.()) ?? {};
  return { ...options.headers, ...dynamic };
}
