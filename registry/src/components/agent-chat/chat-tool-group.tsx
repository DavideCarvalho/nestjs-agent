'use client';

import { cn } from '@/lib/utils';
import type { TranscriptToolBlock, TranscriptToolCall } from '@dudousxd/nestjs-agent-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { ChevronDownIcon, WrenchIcon } from './icons';

/** Draw one call yourself. It carries the part AND whatever human decision the call is parked on. */
export type RenderToolPartFn = (call: TranscriptToolCall) => ReactNode;

export interface ChatToolGroupProps {
  /** A `tools` block off `item.blocks` — the model already decided which calls belong together. */
  block: TranscriptToolBlock;
  renderToolPart?: RenderToolPartFn;
  className?: string;
}

/** One card per tool call in a run, each opening to its input and output. */
export function ChatToolGroup({ block, renderToolPart, className }: ChatToolGroupProps) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {block.calls.map((call) =>
        renderToolPart ? renderToolPart(call) : <ChatToolCard key={call.toolCallId} call={call} />,
      )}
    </div>
  );
}

export interface ChatToolCardProps {
  call: TranscriptToolCall;
  className?: string;
}

export function ChatToolCard({ call, className }: ChatToolCardProps) {
  const [isOpen, setIsOpen] = useState(false);
  const part = call.part;
  const name = call.name;
  const bodyId = `${call.toolCallId}-body`;
  const output = 'output' in part ? part.output : undefined;
  const errorText = 'errorText' in part ? part.errorText : undefined;

  return (
    <div className={cn('overflow-hidden rounded-xl border border-border bg-card', className)}>
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-expanded={isOpen}
        aria-controls={bodyId}
        className={cn(
          'flex w-full items-center gap-2 px-3 py-2 text-left',
          'transition-colors outline-none hover:bg-accent/50',
          'focus-visible:ring-[3px] focus-visible:ring-ring/50',
        )}
      >
        <WrenchIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-sm text-foreground">{name}</span>
        <ToolStateBadge state={call.isAwaitingApproval ? 'approval-requested' : part.state} />
        <ChevronDownIcon
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform',
            isOpen && 'rotate-180',
          )}
        />
      </button>
      {isOpen ? (
        <div id={bodyId} className="flex flex-col gap-2 border-t border-border px-3 py-2.5">
          <ToolPayload label="Input" value={part.input} />
          {errorText !== undefined ? (
            <p className="text-xs text-destructive">{errorText}</p>
          ) : (
            <ToolPayload label="Output" value={output} />
          )}
        </div>
      ) : null}
      <ToolApproval call={call} />
    </div>
  );
}

/** The decision an action tool is parked on. Nothing renders until someone can actually make it. */
function ToolApproval({ call }: { call: TranscriptToolCall }) {
  if (!call.approve.available && !call.reject.available && call.error === null) {
    return null;
  }
  // Both doors close once either decision is on its way, so a second one cannot follow the first
  // for a call the server is already settling. Only the pressed one reports progress — the two
  // `isSubmitting` flags name WHICH decision is going, not merely that one is.
  const isSettling = call.approve.isSubmitting || call.reject.isSubmitting;
  return (
    <div className="flex items-center gap-2 border-t border-border px-3 py-2">
      {call.error ? (
        <p role="alert" className="min-w-0 flex-1 text-xs text-destructive">
          {call.error}
        </p>
      ) : (
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          Waiting for you before it runs.
        </p>
      )}
      {call.reject.available ? (
        <button
          type="button"
          onClick={call.reject.run}
          disabled={isSettling}
          className={cn(
            'shrink-0 rounded-lg px-2.5 py-1 text-xs text-muted-foreground',
            'transition-colors outline-none hover:bg-accent hover:text-foreground',
            'focus-visible:ring-[3px] focus-visible:ring-ring/50',
            'disabled:pointer-events-none disabled:opacity-40',
          )}
        >
          Reject
        </button>
      ) : null}
      {call.approve.available ? (
        <button
          type="button"
          onClick={call.approve.run}
          disabled={isSettling}
          className={cn(
            'shrink-0 rounded-lg bg-foreground px-2.5 py-1 text-xs text-background',
            'transition-opacity outline-none hover:opacity-90',
            'focus-visible:ring-[3px] focus-visible:ring-ring/50',
            'disabled:pointer-events-none disabled:opacity-40',
          )}
        >
          Approve
        </button>
      ) : null}
    </div>
  );
}

const STATE_LABELS: Record<string, string> = {
  'input-streaming': 'Calling',
  'input-available': 'Running',
  'approval-requested': 'Needs approval',
  'output-available': 'Done',
  'output-error': 'Failed',
  'output-denied': 'Denied',
};

function ToolStateBadge({ state }: { state: string }) {
  const isTerminalFailure = state === 'output-error' || state === 'output-denied';
  return (
    <span
      className={cn(
        'shrink-0 rounded-full px-2 py-0.5 text-[0.6875rem] leading-none font-medium',
        isTerminalFailure ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground',
      )}
    >
      {STATE_LABELS[state] ?? state}
    </span>
  );
}

function ToolPayload({ label, value }: { label: string; value: unknown }) {
  if (value === undefined) {
    return null;
  }
  return (
    <div>
      <p className="pb-1 text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </p>
      <pre className="max-h-56 overflow-auto rounded-lg bg-muted/60 p-2 text-xs whitespace-pre-wrap text-muted-foreground">
        {stringify(value)}
      </pre>
    </div>
  );
}

function stringify(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    // A tool can return a cyclic or otherwise unserializable object; the card still has to draw.
    return String(value);
  }
}
