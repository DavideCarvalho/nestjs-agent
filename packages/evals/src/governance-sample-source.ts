import type {
  AgentGovernanceQueries,
  AgentStore,
  GovernanceRunDetail,
  StoredMessage,
} from '@dudousxd/nestjs-agent-core';
import type { RunSampleQuery, RunSampleSource } from './sample-source.js';
import type { ScorableRun, ScorableToolCall } from './types.js';

/**
 * A {@link RunSampleSource} over what the agent already persisted: the run row and its tool-call
 * outcomes from {@link AgentGovernanceQueries}, the prompt and answer text from the thread
 * transcript on {@link AgentStore}. Works against any store adapter that implements both
 * (MikroORM, Drizzle, the in-memory one) — the evals package adds no tables of its own on the read
 * side.
 *
 * Runs and messages are joined on the message's own `runId`. Rows written before the agent recorded
 * it have none, so those fall back to matching by TIME: the prompt is the last `user` message
 * at-or-before `startedAt` (the loop appends it before recording the run's start) and the answer is
 * the last `assistant` message before the NEXT user message. That fallback cannot survive a
 * regenerated turn — the loop truncates the replaced answer, so the old run and the new one both
 * resolve to the surviving text — which is exactly what the recorded `runId` fixes going forward.
 *
 * One seam remains, and this class cannot close it: **a soft-deleted thread reads as empty text.**
 * `getThread` hides it (by design), so the run is still returned, with `input`/`output` as `''` — a
 * rule-based scorer over tool outcomes still works, a judge over the answer has nothing to read.
 */
export class GovernanceRunSampleSource implements RunSampleSource {
  constructor(
    private readonly queries: AgentGovernanceQueries,
    private readonly store: AgentStore,
  ) {}

  async listRuns(query: RunSampleQuery): Promise<ScorableRun[]> {
    const page = await this.queries.runsPage({
      page: 1,
      pageSize: query.limit,
      where: {
        ...(query.agentName !== undefined ? { agentName: query.agentName } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.threadId !== undefined ? { threadId: query.threadId } : {}),
        ...(query.fromDay !== undefined ? { fromDay: query.fromDay } : {}),
        ...(query.toDay !== undefined ? { toDay: query.toDay } : {}),
      },
    });
    // One transcript read per THREAD, not per run: a batch over a busy thread would otherwise
    // re-read the same messages once for every turn it holds.
    const transcripts = new Map<string, StoredMessage[]>();
    const runs: ScorableRun[] = [];
    for (const row of page.rows) {
      const detail = await this.queries.runDetail(row.runId);
      if (detail === null) {
        continue;
      }
      runs.push(await this.assemble(detail, transcripts));
    }
    return runs;
  }

  async getRun(runId: string): Promise<ScorableRun | null> {
    const detail = await this.queries.runDetail(runId);
    if (detail === null) {
      return null;
    }
    return this.assemble(detail, new Map());
  }

  private async assemble(
    detail: GovernanceRunDetail,
    transcripts: Map<string, StoredMessage[]>,
  ): Promise<ScorableRun> {
    const { run } = detail;
    let messages = transcripts.get(run.threadId);
    if (messages === undefined) {
      messages = (await this.store.getThread(run.threadId))?.messages ?? [];
      transcripts.set(run.threadId, messages);
    }
    const { input, output } =
      sliceTurnByRunId(messages, run.runId, run.startedAt) ?? sliceTurn(messages, run.startedAt);
    return {
      runId: run.runId,
      threadId: run.threadId,
      actorRef: run.actorRef,
      agentName: run.agentName,
      status: run.status,
      input,
      output,
      toolCalls: detail.toolCalls.map(
        (call): ScorableToolCall => ({
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          toolType: call.toolType,
          status: call.status,
          executionMs: call.executionMs,
          error: call.error,
        }),
      ),
      durationMs: run.durationMs,
      errorCode: run.errorCode,
      startedAt: run.startedAt,
    };
  }
}

/**
 * The prompt and the final answer of the turn, read off the messages the run itself stamped. `null`
 * ONLY when the transcript carries no stamp at all — rows written before the agent recorded a
 * message's run — which is the caller's signal to fall back to {@link sliceTurn}.
 *
 * A thread that IS stamped but holds nothing for this run yields empty text rather than falling
 * back, and that distinction is the point of the whole field. Regenerating a turn truncates the
 * replaced answer away, so the old run genuinely has no message left; the time-based fallback would
 * walk forward from its prompt and hand it the REPLACEMENT's answer, scoring one run against
 * another's text. Empty is the honest reading — a rule-based scorer over tool outcomes still works,
 * and a judge correctly has nothing to read.
 *
 * A turn can persist several assistant messages (one per model step); the LAST is the answer, the
 * earlier ones are the steps that called tools.
 */
function sliceTurnByRunId(
  messages: StoredMessage[],
  runId: string,
  startedAt: string,
): { input: string; output: string } | null {
  if (!messages.some((message) => message.runId !== undefined)) {
    return null;
  }
  const own = messages
    .filter((message) => message.runId === runId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  let input = '';
  let output = '';
  for (const message of own) {
    if (message.role === 'user') {
      input = message.content;
    } else if (message.role === 'assistant') {
      output = message.content;
    }
  }
  // A regenerated run appends no user message — it re-answers the surviving one, which still carries
  // the EARLIER run's stamp. The prompt really is that message, so the input may be borrowed. The
  // output never is: handing a run another run's answer is the whole reason this stamp exists.
  return { input: input !== '' ? input : sliceTurn(messages, startedAt).input, output };
}

/**
 * The prompt and the final answer of the turn that started at `startedAt`: anchor on the last
 * `user` message at-or-before it, then take the last `assistant` message before the next `user`
 * message. Both are `''` when the transcript has no such message.
 */
function sliceTurn(
  messages: StoredMessage[],
  startedAt: string,
): { input: string; output: string } {
  const ordered = [...messages].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
  let anchor = -1;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const message = ordered[index];
    if (message?.role === 'user' && message.createdAt <= startedAt) {
      anchor = index;
      break;
    }
  }
  let output = '';
  for (let index = anchor + 1; index < ordered.length; index += 1) {
    const message = ordered[index];
    if (message?.role === 'user') {
      break;
    }
    if (message?.role === 'assistant') {
      output = message.content;
    }
  }
  return { input: anchor >= 0 ? (ordered[anchor]?.content ?? '') : '', output };
}
