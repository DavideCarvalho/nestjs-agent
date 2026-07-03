import {
  type DynamicToolUIPart,
  type ToolUIPart,
  type UIMessage,
  isTextUIPart,
  isToolUIPart,
} from 'ai';
import React, { useEffect, useRef, useState } from 'react';

/** A tool UI part on a `UIMessage` — a static `tool-*` part or the `dynamic-tool` part. */
export type AnyToolUIPart = ToolUIPart | DynamicToolUIPart;

export type RenderToolPartFn = (part: AnyToolUIPart, key: string) => React.ReactNode;

/** Render a run of consecutive tool parts as one block (e.g. a collapsible tool group). */
export type RenderToolGroupFn = (parts: AnyToolUIPart[], key: string) => React.ReactNode;

/** Render a message's text — pass a markdown renderer (e.g. `AgentMarkdown`) here if desired. */
export type RenderTextFn = (text: string, ctx: { isStreaming: boolean }) => React.ReactNode;

/** Server-aggregated usage for an assistant turn, shown as a small inline line. */
export interface MessageUsageInfo {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface MessageItemClassNames {
  root?: string;
  /** Resolved per role so user/assistant/system bubbles can differ. */
  byRole?: Partial<Record<UIMessage['role'], string>>;
  text?: string;
  /** The action row under the bubble (copy / fork / regenerate / usage / timestamp). */
  actions?: string;
  actionButton?: string;
  usage?: string;
  timestamp?: string;
  editTextarea?: string;
  editActions?: string;
}

export interface MessageItemProps {
  message: UIMessage;
  renderToolPart?: RenderToolPartFn;
  /** Takes precedence over `renderToolPart` for a run of consecutive tool parts. */
  renderToolGroup?: RenderToolGroupFn;
  renderText?: RenderTextFn;
  classNames?: MessageItemClassNames;
  /** Marks the in-flight assistant bubble (e.g. for a caret animation / deferred markdown render). */
  isStreaming?: boolean;
  /** User bubble gets a pencil → inline textarea; submitting calls back with the new text. */
  editable?: boolean;
  onEditSubmit?: (newText: string) => void | Promise<void>;
  /** Assistant bubble gets a "Regenerate" affordance. */
  regeneratable?: boolean;
  onRegenerate?: () => void | Promise<void>;
  /** When provided, a "Fork" affordance calls back with this message's id. */
  onFork?: (uiMessageId: string) => void | Promise<void>;
  /** Server-aggregated usage for this assistant turn (cost + tokens line). */
  usage?: MessageUsageInfo | null;
  /** ISO timestamp of the persisted message; rendered as a relative-time line when set. */
  createdAt?: string | null;
}

/**
 * Styling-agnostic renderer for a single v6 `UIMessage`. Ports flip's full chat-item UX —
 * copy, fork, regenerate, inline edit-and-resubmit, usage line, relative timestamp, and tool
 * grouping — but with ALL styling left to `classNames` and every action surfaced as a callback,
 * so no design-system / icon / date library is pulled in (relative time uses Intl.RelativeTimeFormat).
 */
export function MessageItem({
  message,
  renderToolPart,
  renderToolGroup,
  renderText,
  classNames,
  isStreaming = false,
  editable,
  onEditSubmit,
  regeneratable,
  onRegenerate,
  onFork,
  usage,
  createdAt,
}: MessageItemProps) {
  const isUser = message.role === 'user';
  const parts = message.parts ?? [];
  const copyableText = extractText(parts);

  const actionRow = (
    <div className={classNames?.actions} data-actions-for={message.role}>
      {copyableText ? (
        <CopyButton text={copyableText} className={classNames?.actionButton} />
      ) : null}
      {onFork ? (
        <button
          type="button"
          onClick={() => void onFork(message.id)}
          className={classNames?.actionButton}
          title="Fork thread from this message"
        >
          Fork
        </button>
      ) : null}
      {!isUser && regeneratable && onRegenerate ? (
        <button
          type="button"
          onClick={() => void onRegenerate()}
          className={classNames?.actionButton}
          title="Regenerate response"
        >
          Regenerate
        </button>
      ) : null}
      {!isUser && usage ? <UsageInline usage={usage} className={classNames?.usage} /> : null}
      {createdAt ? (
        <TimestampInline createdAt={createdAt} className={classNames?.timestamp} />
      ) : null}
    </div>
  );

  if (isUser && editable && onEditSubmit) {
    return (
      <EditableUserBubble
        message={message}
        onSubmit={onEditSubmit}
        renderText={renderText}
        classNames={classNames}
        actions={actionRow}
      />
    );
  }

  const className = [classNames?.root, classNames?.byRole?.[message.role]]
    .filter((entry) => entry)
    .join(' ');

  return (
    <div
      className={className === '' ? undefined : className}
      data-role={message.role}
      data-streaming={isStreaming ? 'true' : undefined}
    >
      <div>
        {renderParts(message, parts, {
          renderText,
          renderToolPart,
          renderToolGroup,
          classNames,
          isStreaming,
        })}
      </div>
      {actionRow}
    </div>
  );
}

interface RenderPartsCtx {
  renderText?: RenderTextFn | undefined;
  renderToolPart?: RenderToolPartFn | undefined;
  renderToolGroup?: RenderToolGroupFn | undefined;
  classNames?: MessageItemClassNames | undefined;
  isStreaming: boolean;
}

/** Walk the parts, buffering consecutive tool parts so they can render as one group. */
function renderParts(
  message: UIMessage,
  parts: NonNullable<UIMessage['parts']>,
  ctx: RenderPartsCtx,
): React.ReactNode[] {
  const blocks: React.ReactNode[] = [];
  let toolBuffer: AnyToolUIPart[] = [];
  let toolGroupCounter = 0;
  let textCounter = 0;

  function flushTools() {
    if (toolBuffer.length === 0) {
      return;
    }
    const key = `${message.id}-tools-${toolGroupCounter++}`;
    if (ctx.renderToolGroup) {
      blocks.push(
        <React.Fragment key={key}>{ctx.renderToolGroup(toolBuffer, key)}</React.Fragment>,
      );
    } else if (ctx.renderToolPart) {
      for (const part of toolBuffer) {
        const partKey = `${message.id}-${part.toolCallId}`;
        blocks.push(
          <React.Fragment key={partKey}>{ctx.renderToolPart(part, partKey)}</React.Fragment>,
        );
      }
    }
    toolBuffer = [];
  }

  for (const part of parts) {
    if (isToolUIPart(part)) {
      toolBuffer.push(part);
      continue;
    }
    flushTools();
    if (isTextUIPart(part)) {
      const key = `${message.id}-text-${textCounter++}`;
      blocks.push(
        <div key={key} className={ctx.classNames?.text}>
          {ctx.renderText ? ctx.renderText(part.text, { isStreaming: ctx.isStreaming }) : part.text}
        </div>,
      );
    }
  }
  flushTools();
  return blocks;
}

interface EditableUserBubbleProps {
  message: UIMessage;
  onSubmit: (newText: string) => void | Promise<void>;
  renderText?: RenderTextFn | undefined;
  classNames?: MessageItemClassNames | undefined;
  actions?: React.ReactNode;
}

function EditableUserBubble({
  message,
  onSubmit,
  renderText,
  classNames,
  actions,
}: EditableUserBubbleProps) {
  const initialText = extractText(message.parts ?? []);
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(initialText);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (isEditing && textareaRef.current) {
      const el = textareaRef.current;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [isEditing]);

  async function handleSave() {
    const next = draft.trim();
    if (!next) {
      return;
    }
    setIsEditing(false);
    await onSubmit(next);
  }

  if (!isEditing) {
    const rootClass = [classNames?.root, classNames?.byRole?.user]
      .filter((entry) => entry)
      .join(' ');
    return (
      <div className={rootClass === '' ? undefined : rootClass} data-role="user">
        <div className={classNames?.text}>
          {renderText ? renderText(initialText, { isStreaming: false }) : initialText}
        </div>
        <button
          type="button"
          onClick={() => {
            setDraft(initialText);
            setIsEditing(true);
          }}
          className={classNames?.actionButton}
          title="Edit & resubmit"
        >
          Edit
        </button>
        {actions}
      </div>
    );
  }

  return (
    <div data-editing="true">
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void handleSave();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            setIsEditing(false);
          }
        }}
        rows={Math.min(8, draft.split('\n').length + 1)}
        className={classNames?.editTextarea}
      />
      <div className={classNames?.editActions}>
        <button type="button" onClick={() => setIsEditing(false)}>
          Cancel
        </button>
        <button type="button" onClick={() => void handleSave()} disabled={!draft.trim()}>
          Resend
        </button>
      </div>
    </div>
  );
}

interface CopyButtonProps {
  text: string;
  className?: string | undefined;
}

function CopyButton({ text, className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be unavailable (insecure context / denied permission) — fail quietly.
    }
  }

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      className={className}
      title={copied ? 'Copied!' : 'Copy message text'}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function UsageInline({
  usage,
  className,
}: { usage: MessageUsageInfo; className?: string | undefined }) {
  const total = usage.inputTokens + usage.outputTokens;
  return (
    <span
      className={className}
      title={`Input ${usage.inputTokens.toLocaleString()} · Output ${usage.outputTokens.toLocaleString()} tokens`}
    >
      {formatCostUsd(usage.costUsd)} · {formatTokensShort(total)}
    </span>
  );
}

function TimestampInline({
  createdAt,
  className,
}: { createdAt: string; className?: string | undefined }) {
  const parsed = new Date(createdAt);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  const absolute = parsed.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <span className={className} title={absolute}>
      {formatRelativeTime(parsed)}
    </span>
  );
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

function formatCostUsd(cost: number): string {
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

function extractText(parts: NonNullable<UIMessage['parts']>): string {
  const out: string[] = [];
  for (const part of parts) {
    if (isTextUIPart(part)) {
      out.push(part.text);
    }
  }
  return out.join('\n\n').trim();
}
