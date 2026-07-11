import { useChat } from '@ai-sdk/react';
import type { ThreadDetail, ThreadSummary } from '@dudousxd/nestjs-agent-core';
import type { UIMessage } from 'ai';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
   *
   * For the common case (no id in hand yet), prefer {@link UseAgentChatOptions.resume} — it does
   * this fetch-and-wire for you.
   */
  resumeRunId?: string;
  /**
   * When `true` and the hook (re)mounts with a `threadId`, the hook fetches the thread and, if its
   * `activeRunId` is non-null (a turn was still streaming when the page loaded/reloaded), attaches
   * to that run's `GET /agent/chat/:runId/stream` automatically — the in-flight turn streams into
   * this session's message state exactly as if the send had happened here. A no-op when `threadId`
   * is omitted (nothing to resume) or the fetched thread has no active run. Default `false`.
   */
  resume?: boolean;
  /** Read at every send to capture a page snapshot for the page-assistant. */
  getPageContext?: () => Record<string, unknown> | null;
  /** Fired after each streamed turn finishes (e.g. to refetch the sidebar). */
  onFinish?: () => void;
  /**
   * Fired once when a threadless chat's first send makes the backend create a thread — carries the
   * new id so the consumer can sync its URL/router. Not fired when `threadId` was supplied. The hook
   * ALSO remembers the id internally, so every subsequent send reuses it (no new thread per message)
   * even before the consumer navigates.
   */
  onThreadCreated?: (threadId: string) => void;
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

  // Auto-resume (`resume: true`): the run id discovered from the thread's `activeRunId`, read by
  // the transport's `getResumeRunId` alongside the explicit `resumeRunId` option. A ref, not state
  // — it must be current by the time the SDK's resume effect (below) fires synchronously off it.
  const autoResumeRunIdRef = useRef<string | undefined>(undefined);
  // Flips once the auto-resume fetch resolves a live run. `useChat`'s own `resume` is a reactive
  // effect dependency (it doesn't need to be `true` at mount), so toggling this after the async
  // thread fetch still attaches to the stream.
  const [autoResume, setAutoResume] = useState(false);
  // The loaded thread's active run, if any — exposed regardless of `resume` so a consumer can
  // render a "still generating" affordance even when it wires resumption itself via `resumeRunId`.
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  // One-shot flag read (and cleared) by the transport's getBody so the next send carries
  // `regenerate: true` — telling the backend to re-run the last exchange instead of appending.
  const regenerateNext = useRef(false);

  // The thread the backend created for a threadless chat, captured from the `meta` frame. Every send
  // after the first reuses it (via getBody) so the conversation stays on ONE thread instead of
  // spawning a new one per message. Reset per mount; an explicit `threadId` option always wins.
  const createdThreadId = useRef<string | undefined>(undefined);

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

  // Auto-resume: on (re)mount with `resume: true` and a `threadId`, read the thread and, if it
  // carries a live `activeRunId`, attach to it — the same GET-stream reconnect `resumeRunId`
  // already wires, just discovered instead of supplied. Re-runs if `resume`/`threadId` change; a
  // stale response from a since-abandoned fetch (thread swapped mid-flight) is dropped via `cancelled`.
  useEffect(() => {
    if (!options.resume || options.threadId === undefined) return;
    let cancelled = false;
    const threadId = options.threadId;
    void client.getThread(threadId).then((thread) => {
      if (cancelled) return;
      setActiveRunId(thread.activeRunId ?? null);
      if (thread.activeRunId != null) {
        autoResumeRunIdRef.current = thread.activeRunId;
        setAutoResume(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [client, options.resume, options.threadId]);

  // Identity-stable: per-render config is read through `latest`.
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable by design
  const transport = useMemo(() => {
    function onMeta(meta: AgentStreamMeta): void {
      setRunId(meta.runId);
      // A threadless chat just had its thread created server-side — remember it so subsequent sends
      // reuse it, and tell the consumer once so it can sync its URL. An explicit threadId option owns
      // the binding, so we never override it here.
      if (
        latest.current.threadId === undefined &&
        meta.threadId &&
        createdThreadId.current !== meta.threadId
      ) {
        createdThreadId.current = meta.threadId;
        latest.current.onThreadCreated?.(meta.threadId);
      }
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
        // Prefer the explicit threadId; else the one the backend created for this chat, so the second
        // and later sends land on the same thread instead of forking a new one each time.
        const threadId = current.threadId ?? createdThreadId.current;
        return {
          ...(threadId !== undefined ? { threadId } : {}),
          ...(pageContext ? { pageContext } : {}),
          ...(regenerate ? { regenerate: true } : {}),
        };
      },
      getResumeRunId: () => latest.current.resumeRunId ?? autoResumeRunIdRef.current,
      onMeta,
    });
  }, []);

  const chat = useChat({
    transport,
    resume: options.resumeRunId !== undefined || autoResume,
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
    /** The `resume`-fetched thread's active run id, or `null` once resolved with none. */
    activeRunId,
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
