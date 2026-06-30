import { isToolUIPart, type UIMessage } from 'ai';
import React from 'react';

type AnyMessagePart = NonNullable<UIMessage['parts']>[number];

/**
 * A tool UI part as carried on a `UIMessage` — the union `isToolUIPart`
 * narrows to (static `tool-*` parts plus the `dynamic-tool` part). Keyed
 * off `toolCallId`, which only the tool parts carry.
 */
export type ToolUIPart = Extract<AnyMessagePart, { toolCallId: string }>;

export type RenderToolPartFn = (
  part: ToolUIPart,
  key: string,
) => React.ReactNode;

/** Render a message's text — pass a markdown renderer here if desired. */
export type RenderTextFn = (text: string) => React.ReactNode;

export interface MessageItemClassNames {
  root?: string;
  /** Resolved per role so user/assistant/system bubbles can differ. */
  byRole?: Partial<Record<UIMessage['role'], string>>;
  text?: string;
}

export interface MessageItemProps {
  message: UIMessage;
  renderToolPart?: RenderToolPartFn;
  renderText?: RenderTextFn;
  classNames?: MessageItemClassNames;
  /** Marks the in-flight assistant bubble (e.g. for a caret animation). */
  isStreaming?: boolean;
}

/**
 * Styling-agnostic renderer for a single `UIMessage`. Walks the v6 parts
 * array: text parts go through `renderText` (plain text by default), tool
 * parts go through `renderToolPart` (skipped when not provided). All
 * visual styling comes from `classNames`.
 */
export function MessageItem({
  message,
  renderToolPart,
  renderText,
  classNames,
  isStreaming,
}: MessageItemProps) {
  const roleClass = classNames?.byRole?.[message.role];
  const className = [classNames?.root, roleClass]
    .filter((entry) => entry)
    .join(' ');

  return (
    <div
      className={className === '' ? undefined : className}
      data-role={message.role}
      data-streaming={isStreaming ? 'true' : undefined}
    >
      {(message.parts ?? []).map((part, index) => {
        const key = `${message.id}-${index}`;
        if (part.type === 'text') {
          return (
            <div key={key} className={classNames?.text}>
              {renderText ? renderText(part.text) : part.text}
            </div>
          );
        }
        if (isToolUIPart(part) && renderToolPart) {
          return (
            <React.Fragment key={key}>
              {renderToolPart(part, key)}
            </React.Fragment>
          );
        }
        return null;
      })}
    </div>
  );
}
