import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { channelName, claimDiagnostics } from '@dudousxd/nestjs-diagnostics';
import type { Watcher, WatcherContext } from '@dudousxd/nestjs-telescope';

/**
 * The diagnostics coordinates `@dudousxd/nestjs-agent-rag` publishes retrieval telemetry on. Kept as
 * literals rather than imported from that package, exactly as {@link AgentTelescopeWatcher} depends
 * on the diagnostics channel and not on the agent runtime: this extension must stay installable by a
 * host that has Telescope and the agent but no retrieval stack at all, and adding a dependency on the
 * rag package to read two strings would drag pg/redis-shaped code into every such install. The
 * channel name is the published wire contract (`RAG_RETRIEVAL_CHANNEL` on the producer side).
 */
const RAG_LIB = 'rag';
const RETRIEVAL_EVENT = 'retrieval';

/** The Telescope entry `type` retrieval events are recorded as — see the class doc. */
export const RAG_ENTRY_TYPE = 'agent-rag';

/** The envelope `@dudousxd/nestjs-diagnostics` publishes: metadata plus the emitter's payload. */
interface DiagnosticEnvelope {
  event: string;
  durationMs?: number;
  payload: Record<string, unknown>;
}

function isEnvelope(message: unknown): message is DiagnosticEnvelope {
  return (
    typeof message === 'object' &&
    message !== null &&
    typeof Reflect.get(message, 'payload') === 'object' &&
    Reflect.get(message, 'payload') !== null
  );
}

/**
 * Records `aviary:rag:retrieval` events as Telescope entries of type `agent-rag` — the source every
 * RAG panel on the Agent dashboard reads.
 *
 * **Its own entry type, not `agent`.** Retrieval is per-tool-call where a run is per-conversation, so
 * a busy hour produces an order of magnitude more retrieval events than agent events. Sharing the
 * `agent` type would put them in one storage window: the providers page 5k entries of a type, and
 * retrieval traffic would push `run.finished` out of that window, quietly zeroing the Runs and Tokens
 * stats that have nothing to do with RAG. Separate types make the two independent, and give the
 * Entries screen a "RAG" filter that lists retrievals and only retrievals.
 *
 * **The duration is lifted off the ENVELOPE into the entry content.** The emitter puts it there
 * (`emit`'s `opts.durationMs`) because that is the field Telescope's OTel exporter turns into a
 * latency histogram; the panels need it as an ordinary field they can bucket, and an entry's content
 * is all a `DataProvider` gets. Recording it in both places would mean two sources of truth for the
 * same number, so it is lifted rather than duplicated at the emitter.
 *
 * Claims `rag:retrieval` (refcounted, released in `dispose()`) so
 * `@dudousxd/nestjs-diagnostics-telescope`'s generic bridge skips it instead of recording every
 * retrieval a second time as a generic `diagnostic` entry.
 *
 * Registered by `agentTelescopeExtension()`; also usable on its own in a host's `watchers` list.
 */
export class RagTelescopeWatcher implements Watcher {
  readonly type = RAG_ENTRY_TYPE;
  private readonly disposers: Array<() => void> = [];

  register(ctx: WatcherContext): void {
    this.disposers.push(claimDiagnostics(RAG_LIB, [RETRIEVAL_EVENT]));
    const channel = channelName(RAG_LIB, RETRIEVAL_EVENT);
    const onMessage = (message: unknown) => {
      if (!isEnvelope(message)) {
        return;
      }
      ctx.record({
        type: RAG_ENTRY_TYPE,
        content: {
          event: RETRIEVAL_EVENT,
          ...message.payload,
          ...(message.durationMs !== undefined ? { durationMs: message.durationMs } : {}),
        },
        // Tagged by store and retriever kind so the Entries screen can filter to "every retrieval
        // pgvector served" without a provider — the same tag-per-dimension the agent watcher uses.
        tags: tagsOf(message.payload),
      });
    };
    subscribe(channel, onMessage);
    this.disposers.push(() => unsubscribe(channel, onMessage));
  }

  /** Detach the subscription and release the diagnostics claim (e.g. on module destroy). */
  dispose(): void {
    while (this.disposers.length) this.disposers.pop()?.();
  }
}

/** `retriever:<kind>` / `store:<kind>` / `zero-hit` / `failed`, for whichever the payload carries. */
function tagsOf(payload: Record<string, unknown>): string[] {
  const tags = [RETRIEVAL_EVENT];
  if (typeof payload.retriever === 'string') {
    tags.push(`retriever:${payload.retriever}`);
  }
  if (typeof payload.store === 'string') {
    tags.push(`store:${payload.store}`);
  }
  if (payload.zeroHit === true) {
    tags.push('zero-hit');
  }
  if (payload.failed === true) {
    tags.push('failed');
  }
  return tags;
}
