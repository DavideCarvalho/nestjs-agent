import {
  type DynamicToolUIPart,
  type FileUIPart,
  type ToolUIPart,
  type UIMessage,
  getToolName,
  isFileUIPart,
  isReasoningUIPart,
  isTextUIPart,
  isToolUIPart,
} from 'ai';

/** A tool UI part on a `UIMessage` — a static `tool-*` part or the `dynamic-tool` part. */
export type AnyToolUIPart = ToolUIPart | DynamicToolUIPart;

export type ChatStatus = 'ready' | 'submitted' | 'streaming' | 'error';

/** Server-aggregated usage for an assistant turn. */
export interface MessageUsageInfo {
  inputTokens: number;
  outputTokens: number;
  /**
   * `null` when no price is on record for the model that ran the turn. Distinct from `0`, which is
   * a turn that genuinely cost nothing — printing `$0` for an unpriced turn states a number the
   * store never had.
   */
  costUsd: number | null;
}

/** A run of contiguous prose. `isStreaming` is the PART's own state, not the message's. */
export interface TranscriptTextBlock {
  kind: 'text';
  key: string;
  text: string;
  isStreaming: boolean;
}

/** One file on a message — an uploaded attachment, or one the model produced. */
export interface TranscriptFile {
  /** Presigned or otherwise directly fetchable. Display-only: the model reads its own copy. */
  url: string;
  mediaType: string;
  filename: string | null;
  /** `image/*`, which a renderer can show inline rather than as a link. */
  isImage: boolean;
}

/** A run of contiguous files. Grouped so a renderer can lay several out as one strip. */
export interface TranscriptFilesBlock {
  kind: 'files';
  key: string;
  files: TranscriptFile[];
}

/**
 * A run of contiguous reasoning. Carries its own disclosure state because a thread can hold many
 * of them and each is toggled independently; `isOpen` defaults to `isStreaming` (thinking is worth
 * watching live, worth folding away once answered) until `toggle` is called for that run.
 */
export interface TranscriptReasoningBlock {
  kind: 'reasoning';
  key: string;
  text: string;
  isStreaming: boolean;
  isOpen: boolean;
  toggle: (open?: boolean) => void;
}

/** An action a run is waiting on a human for: approve, reject, answer, skip. */
/**
 * Which decision a parked call is currently sending. One call can only be settling one way at a
 * time, and WHICH one is what lets a surface report progress on the affordance the person pressed
 * instead of on all of them.
 */
export type SettleAction = 'approve' | 'reject' | 'answer' | 'skip';

export interface TranscriptSettleState {
  available: boolean;
  /** True from the click until the run resumes and settles the call. */
  isSubmitting: boolean;
  run: () => void;
}

/** One call in a tool run, with whatever human decision it is parked on. */
export interface TranscriptToolCall {
  part: AnyToolUIPart;
  toolCallId: string;
  name: string;
  /**
   * Parked on a person. An `action` tool's input lands and its output never follows on its own —
   * the loop waits for an approval between the two — so a settled-looking card that never settles
   * IS the pending approval.
   */
  isAwaitingApproval: boolean;
  approve: TranscriptSettleState;
  reject: TranscriptSettleState;
  /** A failed decision — the call is still parked, so the affordance stays live. */
  error: string | null;
}

/**
 * A run of CONSECUTIVE tool parts, grouped so a UI can collapse "5 tools ran" into one affordance.
 * Any non-tool part between two tool parts ends the run — including the AI SDK's `step-start`
 * markers, so tools from different steps never merge into one group.
 */
export interface TranscriptToolBlock {
  kind: 'tools';
  key: string;
  parts: AnyToolUIPart[];
  /** The same calls, each with its human-decision state. Same order as `parts`. */
  calls: TranscriptToolCall[];
}

/** One choice a question offers, with its live selection state. */
export interface TranscriptQuestionOption {
  value: string;
  label: string;
  /** A single character the request suggested as a shortcut; `null` when it suggested none. */
  hotkey: string | null;
  isSelected: boolean;
  /** Pre-picked by the agent — what an untouched question submits as. */
  isDefault: boolean;
  /** Single choice: replaces the selection. Multiple: adds or removes this value. */
  select: () => void;
}

/** One question of a set, numbered against the whole. */
export interface TranscriptQuestion {
  id: string;
  prompt: string;
  multiple: boolean;
  /** 1-based. The request carries every question up front, so "Question 1 of N" is honest. */
  position: number;
  options: TranscriptQuestionOption[];
  selected: string[];
  /**
   * The user has not touched this question, so a submission leaves it out and the server applies
   * the same defaults it showed. Distinct from "selected happens to equal the defaults": only the
   * first is recorded as `defaulted` rather than as a choice the user made.
   */
  isPristine: boolean;
}

/** How a question set settled, once it did. */
export interface TranscriptElicitationOutcome {
  answers: Record<string, string[]>;
  /** The user declined to answer and let the agent proceed on its own picks. */
  skipped: boolean;
  /** Questions filled from their own defaults rather than by the human. */
  defaulted: string[];
  /** The questions against the chosen labels, as the model read them back. */
  summary: string | null;
}

/**
 * A question set the run put to the user, parked until someone settles it — the intake an agent
 * declares and the model's own `ask` produce the same block, because the loop streams the same
 * frame for both.
 */
export interface TranscriptElicitationBlock {
  kind: 'elicitation';
  key: string;
  /** The parked tool call — what `answer`/`skip` route by. */
  toolCallId: string;
  preamble: string | null;
  questions: TranscriptQuestion[];
  questionCount: number;
  /** Still waiting on a human. */
  isPending: boolean;
  outcome: TranscriptElicitationOutcome | null;
  /** A failed submission — the run is still parked, so the form stays live. */
  error: string | null;
  answer: TranscriptSettleState;
  skip: TranscriptSettleState;
}

/** One retrieved passage, as it rides a retrieval tool call's output. Mirrors core's `Passage`. */
export interface RetrievedPassage {
  id: string;
  text: string;
  score: number;
  /** Citation-facing origin — a document title, URL or row id. */
  source?: string;
  metadata?: Record<string, unknown>;
}

/** The passages of one origin, folded together so a citation line reads once per source. */
export interface TranscriptSource {
  /** The `source` string the retriever stamped, falling back to the passage id when it stamped none. */
  id: string;
  label: string;
  passageCount: number;
  /** Highest relevance among this source's passages; the scale is the retriever's. */
  topScore: number;
  passages: RetrievedPassage[];
}

/**
 * The provenance behind an answer: a run of CONSECUTIVE retrieval tool parts, aggregated by origin.
 * Detection is structural — a tool output shaped `{ passages: [{ id, text, ... }] }` — because the
 * tool's NAME is not fixed: inject-mode retrieval persists as `retrieve`, and `createRetrievalTool`
 * lets the host rename `search_knowledge` to anything.
 */
export interface TranscriptSourcesBlock {
  kind: 'sources';
  key: string;
  /** What was searched, when the tool call recorded a `{ query }` input. */
  query: string | null;
  sources: TranscriptSource[];
  passageCount: number;
}

export type TranscriptBlock =
  | TranscriptTextBlock
  | TranscriptFilesBlock
  | TranscriptReasoningBlock
  | TranscriptToolBlock
  | TranscriptSourcesBlock
  | TranscriptElicitationBlock;

/** Where a question set's selection state is held, and where its settlement is sent. */
export interface ElicitationBlockOptions {
  /** The values a question is showing, or `undefined` while the user has not touched it. */
  picked: (toolCallId: string, questionId: string) => string[] | undefined;
  pick: (toolCallId: string, questionId: string, values: string[]) => void;
  canAnswer: boolean;
  canSkip: boolean;
  answer: (toolCallId: string) => void;
  skip: (toolCallId: string) => void;
  /** Which decision this call is sending, or `null` for none. */
  submitting: (toolCallId: string) => SettleAction | null;
  errorOf: (toolCallId: string) => string | null;
}

/** Where an approval decision is sent, and what the last one did. */
export interface ApprovalBlockOptions {
  canApprove: boolean;
  canReject: boolean;
  approve: (toolCallId: string) => void;
  reject: (toolCallId: string) => void;
  /** Which decision this call is sending, or `null` for none. */
  submitting: (toolCallId: string) => SettleAction | null;
  errorOf: (toolCallId: string) => string | null;
}

export interface BuildBlocksOptions {
  /** Disclosure lookup for a reasoning run; `isStreaming` is the fallback when untouched. */
  isReasoningOpen: (key: string, isStreaming: boolean) => boolean;
  toggleReasoning: (key: string, open?: boolean) => void;
  /**
   * Lift retrieval tool parts out of the tool run into a `sources` block. Off by default, so a
   * renderer wired to draw tool cards keeps receiving them as the tool calls they are.
   */
  sources?: boolean;
  /**
   * Lift a question set out of the tool run into an `elicitation` block. Omitted → it stays a tool
   * card, which is all a host that has nowhere to send an answer could render anyway.
   */
  elicitation?: ElicitationBlockOptions;
  /** Wire approve/reject onto the calls parked on a human. Omitted → they are reported, not actionable. */
  approval?: ApprovalBlockOptions;
}

/**
 * Walk a message's parts into renderable blocks, buffering consecutive tool parts into one run and
 * consecutive files into one strip. Parts this library has no model for (`data-*`) are dropped
 * rather than guessed at, but they still terminate a tool run — their position in the transcript is
 * meaningful even when their content is not modelled here.
 */
export function buildTranscriptBlocks(
  message: UIMessage,
  options: BuildBlocksOptions,
): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  let toolBuffer: AnyToolUIPart[] = [];
  let retrievalBuffer: AnyToolUIPart[] = [];
  let fileBuffer: FileUIPart[] = [];
  let toolCounter = 0;
  let textCounter = 0;
  let fileCounter = 0;
  let reasoningCounter = 0;
  let sourcesCounter = 0;
  let elicitationCounter = 0;

  function flushTools() {
    if (toolBuffer.length === 0) {
      return;
    }
    blocks.push({
      kind: 'tools',
      key: `${message.id}-tools-${toolCounter++}`,
      parts: toolBuffer,
      calls: toolBuffer.map((part) => buildToolCall(part, options.approval)),
    });
    toolBuffer = [];
  }

  function flushSources() {
    if (retrievalBuffer.length === 0) {
      return;
    }
    blocks.push(buildSourcesBlock(`${message.id}-sources-${sourcesCounter++}`, retrievalBuffer));
    retrievalBuffer = [];
  }

  function flushFiles() {
    if (fileBuffer.length === 0) {
      return;
    }
    blocks.push({
      kind: 'files',
      key: `${message.id}-files-${fileCounter++}`,
      files: fileBuffer.map((part) => ({
        url: part.url,
        mediaType: part.mediaType,
        filename: part.filename ?? null,
        isImage: part.mediaType.startsWith('image/'),
      })),
    });
    fileBuffer = [];
  }

  function flushAll() {
    flushTools();
    flushSources();
    flushFiles();
  }

  for (const part of message.parts ?? []) {
    if (isToolUIPart(part)) {
      const elicitation = options.elicitation;
      if (elicitation !== undefined) {
        const request = readElicitationRequest(part);
        if (request !== null) {
          flushAll();
          blocks.push(
            buildElicitationBlock(
              `${message.id}-elicitation-${elicitationCounter++}`,
              part,
              request,
              elicitation,
            ),
          );
          continue;
        }
      }
      if (options.sources === true && readPassages(part) !== null) {
        flushTools();
        retrievalBuffer.push(part);
        continue;
      }
      flushSources();
      flushFiles();
      toolBuffer.push(part);
      continue;
    }
    if (isFileUIPart(part)) {
      flushTools();
      flushSources();
      fileBuffer.push(part);
      continue;
    }
    flushAll();
    if (isTextUIPart(part)) {
      blocks.push({
        kind: 'text',
        key: `${message.id}-text-${textCounter++}`,
        text: part.text,
        isStreaming: part.state === 'streaming',
      });
      continue;
    }
    if (isReasoningUIPart(part)) {
      const key = `${message.id}-reasoning-${reasoningCounter++}`;
      const isStreaming = part.state === 'streaming';
      blocks.push({
        kind: 'reasoning',
        key,
        text: part.text,
        isStreaming,
        isOpen: options.isReasoningOpen(key, isStreaming),
        toggle: (open?: boolean) => options.toggleReasoning(key, open),
      });
    }
  }
  flushAll();
  return blocks;
}

/**
 * Fold a run of retrieval parts into one provenance block. Sources keep the order the retriever
 * returned them in — that order IS the ranking — and the query is taken from the first call that
 * recorded one.
 */
function buildSourcesBlock(key: string, parts: AnyToolUIPart[]): TranscriptSourcesBlock {
  const byId = new Map<string, TranscriptSource>();
  let query: string | null = null;
  let passageCount = 0;

  for (const part of parts) {
    query ??= readQuery(part);
    for (const passage of readPassages(part) ?? []) {
      passageCount++;
      const id = passage.source ?? passage.id;
      const existing = byId.get(id);
      if (existing) {
        existing.passageCount++;
        existing.topScore = Math.max(existing.topScore, passage.score);
        existing.passages.push(passage);
        continue;
      }
      byId.set(id, {
        id,
        label: passage.source ?? passage.id,
        passageCount: 1,
        topScore: passage.score,
        passages: [passage],
      });
    }
  }

  return { kind: 'sources', key, query, sources: [...byId.values()], passageCount };
}

/** A call whose output has landed one way or another is nobody's decision any more. */
function isSettled(state: string): boolean {
  return state === 'output-available' || state === 'output-error' || state === 'output-denied';
}

function toolKind(part: AnyToolUIPart): string | undefined {
  const metadata = (part as { toolMetadata?: unknown }).toolMetadata;
  return isRecord(metadata) && typeof metadata.toolKind === 'string'
    ? metadata.toolKind
    : undefined;
}

/**
 * An `action` tool's input lands and then nothing follows: the loop waits on a person between the
 * call and its execution. So a call classified `action` and stuck at `input-available` IS the
 * pending approval — there is no separate frame that says so.
 */
function isAwaitingApproval(part: AnyToolUIPart): boolean {
  if (part.state === 'approval-requested') {
    return true;
  }
  if (part.state !== 'input-available') {
    return false;
  }
  // A question set parks the same way and is persisted as an action, but it is settled by
  // answering it, not by approving it.
  return toolKind(part) === 'action' && readElicitationRequest(part) === null;
}

function buildToolCall(part: AnyToolUIPart, options?: ApprovalBlockOptions): TranscriptToolCall {
  const toolCallId = part.toolCallId;
  const awaiting = isAwaitingApproval(part);
  // Per decision, not per call: the two are never in flight together, and a surface that read one
  // flag for both would report the refusal it is carrying out as an approval in progress.
  const sending = awaiting ? (options?.submitting(toolCallId) ?? null) : null;
  return {
    part,
    toolCallId,
    name: getToolName(part),
    isAwaitingApproval: awaiting,
    approve: {
      available: awaiting && options?.canApprove === true,
      isSubmitting: sending === 'approve',
      run: () => options?.approve(toolCallId),
    },
    reject: {
      available: awaiting && options?.canReject === true,
      isSubmitting: sending === 'reject',
      run: () => options?.reject(toolCallId),
    },
    error: options?.errorOf(toolCallId) ?? null,
  };
}

/** A question as the request wrote it, before any of the user's picks are applied. */
interface ElicitationQuestionData {
  id: string;
  prompt: string;
  multiple: boolean;
  defaults: string[];
  options: { value: string; label: string; hotkey: string | null }[];
}

/**
 * The question set a tool call carries, or `null` for any other tool. Read from the call's INPUT
 * and by shape rather than by tool name: the same set is authored by an agent's intake and by the
 * model's own `ask`, it replays from the store under whatever name the row holds, and a client
 * that learned to recognise one name would render only half of them.
 */
function readElicitationRequest(
  part: AnyToolUIPart,
): { preamble: string | null; questions: ElicitationQuestionData[] } | null {
  const input = (part as { input?: unknown }).input;
  if (!isRecord(input) || !Array.isArray(input.questions) || input.questions.length === 0) {
    return null;
  }
  const questions: ElicitationQuestionData[] = [];
  for (const candidate of input.questions) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== 'string' ||
      typeof candidate.prompt !== 'string' ||
      !Array.isArray(candidate.options) ||
      candidate.options.length === 0
    ) {
      return null;
    }
    const options: ElicitationQuestionData['options'] = [];
    for (const option of candidate.options) {
      if (
        !isRecord(option) ||
        typeof option.value !== 'string' ||
        typeof option.label !== 'string'
      ) {
        return null;
      }
      options.push({
        value: option.value,
        label: option.label,
        hotkey: typeof option.hotkey === 'string' ? option.hotkey : null,
      });
    }
    questions.push({
      id: candidate.id,
      prompt: candidate.prompt,
      multiple: candidate.multiple === true,
      defaults: Array.isArray(candidate.defaults)
        ? candidate.defaults.filter((value): value is string => typeof value === 'string')
        : [],
      options,
    });
  }
  return {
    preamble: typeof input.preamble === 'string' ? input.preamble : null,
    questions,
  };
}

/** What the run recorded for a settled question set, or `null` when it settled as something else. */
function readElicitationOutcome(part: AnyToolUIPart): TranscriptElicitationOutcome | null {
  const output = (part as { output?: unknown }).output;
  if (!isRecord(output) || !isRecord(output.answers) || typeof output.skipped !== 'boolean') {
    return null;
  }
  const answers: Record<string, string[]> = {};
  for (const [id, values] of Object.entries(output.answers)) {
    answers[id] = Array.isArray(values)
      ? values.filter((value): value is string => typeof value === 'string')
      : [];
  }
  return {
    answers,
    skipped: output.skipped,
    defaulted: Array.isArray(output.defaulted)
      ? output.defaulted.filter((id): id is string => typeof id === 'string')
      : [],
    summary: typeof output.summary === 'string' ? output.summary : null,
  };
}

function buildElicitationBlock(
  key: string,
  part: AnyToolUIPart,
  request: { preamble: string | null; questions: ElicitationQuestionData[] },
  options: ElicitationBlockOptions,
): TranscriptElicitationBlock {
  const toolCallId = part.toolCallId;
  const isPending = !isSettled(part.state);
  const outcome = isPending ? null : readElicitationOutcome(part);
  const questions = request.questions.map((question, index) => {
    const picked = isPending ? options.picked(toolCallId, question.id) : undefined;
    const selected = picked ?? outcome?.answers[question.id] ?? question.defaults;
    const pick = (values: string[]) => options.pick(toolCallId, question.id, values);
    return {
      id: question.id,
      prompt: question.prompt,
      multiple: question.multiple,
      position: index + 1,
      selected,
      isPristine: isPending
        ? picked === undefined
        : (outcome?.defaulted.includes(question.id) ?? true),
      options: question.options.map((option) => ({
        value: option.value,
        label: option.label,
        hotkey: option.hotkey,
        isSelected: selected.includes(option.value),
        isDefault: question.defaults.includes(option.value),
        select: () => {
          if (!isPending) {
            return;
          }
          if (!question.multiple) {
            pick([option.value]);
            return;
          }
          pick(
            selected.includes(option.value)
              ? selected.filter((value) => value !== option.value)
              : [...selected, option.value],
          );
        },
      })),
    };
  });
  const sending = isPending ? options.submitting(toolCallId) : null;
  return {
    kind: 'elicitation',
    key,
    toolCallId,
    preamble: request.preamble,
    questions,
    questionCount: questions.length,
    isPending,
    outcome,
    error: options.errorOf(toolCallId),
    answer: {
      available: isPending && options.canAnswer,
      isSubmitting: sending === 'answer',
      run: () => options.answer(toolCallId),
    },
    skip: {
      available: isPending && options.canSkip,
      isSubmitting: sending === 'skip',
      run: () => options.skip(toolCallId),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readQuery(part: AnyToolUIPart): string | null {
  const input = (part as { input?: unknown }).input;
  if (!isRecord(input) || typeof input.query !== 'string') {
    return null;
  }
  return input.query;
}

/**
 * The passages on a settled retrieval tool call, or `null` for any other tool. A call still in
 * flight, or one whose output is not a non-empty list of `{ id, text }` passages, is not provenance
 * yet and stays an ordinary tool part.
 */
function readPassages(part: AnyToolUIPart): RetrievedPassage[] | null {
  const output = (part as { output?: unknown }).output;
  if (!isRecord(output) || !Array.isArray(output.passages) || output.passages.length === 0) {
    return null;
  }
  const passages: RetrievedPassage[] = [];
  for (const candidate of output.passages) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== 'string' ||
      typeof candidate.text !== 'string'
    ) {
      return null;
    }
    passages.push({
      id: candidate.id,
      text: candidate.text,
      score: typeof candidate.score === 'number' ? candidate.score : 0,
      ...(typeof candidate.source === 'string' ? { source: candidate.source } : {}),
      ...(isRecord(candidate.metadata) ? { metadata: candidate.metadata } : {}),
    });
  }
  return passages;
}

/** The message's prose, joined for the clipboard. Reasoning is excluded — it is not the answer. */
export function extractMessageText(parts: UIMessage['parts'] | undefined): string {
  const out: string[] = [];
  for (const part of parts ?? []) {
    if (isTextUIPart(part)) {
      out.push(part.text);
    }
  }
  return out.join('\n\n').trim();
}

export interface UsageSummary extends MessageUsageInfo {
  totalTokens: number;
  /** `$0`, `$0.0123`, `$0.012`, `$1.23` — precision follows magnitude so sub-cent turns stay legible. */
  costLabel: string;
  tokensLabel: string;
}

export function describeUsage(usage: MessageUsageInfo): UsageSummary {
  const totalTokens = usage.inputTokens + usage.outputTokens;
  return {
    ...usage,
    totalTokens,
    costLabel: formatCostUsd(usage.costUsd),
    tokensLabel: formatTokensShort(totalTokens),
  };
}

export interface TimestampInfo {
  iso: string;
  date: Date;
  /** "just now" / "5 min. ago" / "Mar 3" — see {@link formatRelativeTime}. */
  relative: string;
  absolute: string;
}

/** `null` for an unparseable stamp, so a bad `created_at` renders nothing instead of "Invalid Date". */
export function describeTimestamp(createdAt: string | null | undefined): TimestampInfo | null {
  if (createdAt == null) {
    return null;
  }
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return {
    iso: createdAt,
    date,
    relative: formatRelativeTime(date),
    absolute: date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
  };
}

const RELATIVE_TIME = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'narrow' });
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * "just now" within ±10s (server `created_at` can land a few ms ahead of the client clock), a
 * relative phrase up to a week, then a calendar date. Uses Intl.RelativeTimeFormat — no date-fns.
 */
export function formatRelativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  if (Math.abs(diffMs) < 10_000) {
    return 'just now';
  }
  if (diffMs > ONE_WEEK_MS) {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  const minutes = Math.round(-diffMs / 60_000);
  if (Math.abs(minutes) < 60) {
    return RELATIVE_TIME.format(minutes, 'minute');
  }
  const hours = Math.round(-diffMs / 3_600_000);
  if (Math.abs(hours) < 24) {
    return RELATIVE_TIME.format(hours, 'hour');
  }
  return RELATIVE_TIME.format(Math.round(-diffMs / 86_400_000), 'day');
}

function formatTokensShort(n: number): string {
  if (n < 1_000) {
    return `${n} tokens`;
  }
  if (n < 10_000) {
    return `${(n / 1_000).toFixed(1)}k tokens`;
  }
  return `${Math.round(n / 1_000)}k tokens`;
}

function formatCostUsd(cost: number | null): string {
  if (cost === null) {
    return '—';
  }
  if (cost === 0) {
    return '$0';
  }
  if (cost < 0.01) {
    return `$${cost.toFixed(4)}`;
  }
  if (cost < 1) {
    return `$${cost.toFixed(3)}`;
  }
  return `$${cost.toFixed(2)}`;
}
