'use client';

import { cn } from '@/lib/utils';
import {
  type AutocompleteSource,
  type ChatStatus,
  type MessageUsageInfo,
  type TranscriptSource,
  useChatTranscript,
} from '@dudousxd/nestjs-agent-react';
import type { UIMessage } from 'ai';
import type { ReactNode } from 'react';
import { ChatCommandPalette, type ChatSuggestion } from './chat-command-palette';
import { ChatComposer } from './chat-composer';
import { type ChatContextSource, ChatContextStrip } from './chat-context-strip';
import { type ChatMode, ChatModePills } from './chat-mode-pills';
import type { RenderToolPartFn } from './chat-tool-group';
import { ChatTranscriptView } from './chat-transcript';
import { ChatWelcome } from './chat-welcome';

export interface AgentChatProps {
  /** `chat.messages` and `chat.status` from `useAgentChat` — or any AI SDK v7 chat. */
  messages: UIMessage[];
  status: ChatStatus;
  onSubmit: (text: string) => void;
  /** Cancel the turn in flight — `chat.cancel`. Without it the composer offers no stop. */
  onStop?: () => void | Promise<void>;
  editable?: boolean;
  onEditSubmit?: (messageId: string, text: string) => void | Promise<void>;
  onFork?: (messageId: string) => void | Promise<void>;
  regeneratable?: boolean;
  onRegenerate?: (messageId: string) => void | Promise<void>;
  getUsage?: (message: UIMessage) => MessageUsageInfo | null;
  getCreatedAt?: (message: UIMessage) => string | null;
  followUps?: string[];

  /**
   * Settle a parked question set — `chat.answer`. Supplying it is what puts the form on screen at
   * all: an agent's intake and the model's own `ask` both park the run until someone answers.
   */
  onAnswer?: (toolCallId: string, answers: Record<string, string[]>) => void | Promise<void>;
  onSkip?: (toolCallId: string) => void | Promise<void>;
  /** Settle a tool call parked on a human — `chat.approve` / `chat.reject`. */
  onApprove?: (toolCallId: string) => void | Promise<void>;
  onReject?: (toolCallId: string) => void | Promise<void>;

  welcomeTitle?: ReactNode;
  welcomeDescription?: ReactNode;
  welcomeMark?: ReactNode;

  modes?: ChatMode[];
  mode?: string | null;
  onModeChange?: (mode: ChatMode) => void;

  contextSources?: ChatContextSource[];
  contextTotal?: number;
  onAddContext?: () => void;

  suggestions?: ChatSuggestion[];
  onSuggestionSelect?: (suggestion: ChatSuggestion) => void;
  onDismissSuggestions?: () => void;

  /**
   * What the composer completes, and after which character — `/` for a skill, `@` for a mention.
   * Nothing here knows what a source offers; adding a second trigger is another entry in the array.
   */
  autocompleteSources?: readonly AutocompleteSource[];
  onAutocompleteError?: (error: unknown, source: AutocompleteSource) => void;

  onAttach?: () => void;
  /** Left of the submit control — a model picker, a temperature toggle. */
  composerTrailing?: ReactNode;
  placeholder?: string;

  renderText?: (text: string, ctx: { isStreaming: boolean }) => ReactNode;
  reasoningLabel?: ReactNode;
  renderSourceIcon?: (source: TranscriptSource) => ReactNode;
  onSourceClick?: (source: TranscriptSource) => void;
  sourceChips?: boolean;
  /** Draw a tool call yourself — it arrives with whatever human decision it is parked on. */
  renderToolPart?: RenderToolPartFn;
  className?: string;
}

/**
 * The whole chat surface over `useChatTranscript`: a welcome state until the first message, then a
 * scrolling transcript with the composer docked beneath it. Every branch it makes is a boolean the
 * model already computed.
 */
export function AgentChat({
  messages,
  status,
  onSubmit,
  onStop,
  editable,
  onEditSubmit,
  onFork,
  regeneratable,
  onRegenerate,
  getUsage,
  getCreatedAt,
  followUps,
  onAnswer,
  onSkip,
  onApprove,
  onReject,
  welcomeTitle = 'What should I look through?',
  welcomeDescription,
  welcomeMark,
  modes,
  mode = null,
  onModeChange,
  contextSources,
  contextTotal,
  onAddContext,
  suggestions,
  onSuggestionSelect,
  onDismissSuggestions,
  autocompleteSources,
  onAutocompleteError,
  onAttach,
  composerTrailing,
  placeholder,
  renderText,
  reasoningLabel,
  renderSourceIcon,
  onSourceClick,
  sourceChips = false,
  renderToolPart,
  className,
}: AgentChatProps) {
  const transcript = useChatTranscript({
    messages,
    status,
    sources: true,
    onStop,
    editable,
    onEditSubmit,
    onFork,
    regeneratable,
    onRegenerate,
    getUsage,
    getCreatedAt,
    followUps,
    onAnswer,
    onSkip,
    onApprove,
    onReject,
  });

  const composer = (
    <ChatComposer
      onSubmit={onSubmit}
      stop={transcript.stop}
      placeholder={placeholder}
      onAttach={onAttach}
      trailing={composerTrailing}
      {...(autocompleteSources !== undefined ? { autocompleteSources } : {})}
      {...(onAutocompleteError !== undefined ? { onAutocompleteError } : {})}
      overlay={
        suggestions && onSuggestionSelect ? (
          <ChatCommandPalette
            suggestions={suggestions}
            onSelect={onSuggestionSelect}
            onClose={onDismissSuggestions}
          />
        ) : null
      }
      footer={
        contextSources ? (
          <ChatContextStrip sources={contextSources} total={contextTotal} onAdd={onAddContext} />
        ) : null
      }
    />
  );

  const modePills =
    modes && modes.length > 0 ? (
      <ChatModePills modes={modes} value={mode} onSelect={onModeChange} />
    ) : null;

  if (transcript.showEmptyState) {
    return (
      <div className={cn('flex h-full flex-col justify-center', className)}>
        <ChatWelcome
          title={welcomeTitle}
          description={welcomeDescription}
          mark={welcomeMark}
          footer={modePills}
        >
          {composer}
        </ChatWelcome>
      </div>
    );
  }

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <ChatTranscriptView
        transcript={transcript}
        sourceChips={sourceChips}
        renderText={renderText}
        reasoningLabel={reasoningLabel}
        renderSourceIcon={renderSourceIcon}
        onSourceClick={onSourceClick}
        renderToolPart={renderToolPart}
        followUps={followUps}
        onFollowUpSelect={onSubmit}
      />
      <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-4">
        {composer}
        {modePills ? <div className="pt-3">{modePills}</div> : null}
      </div>
    </div>
  );
}
