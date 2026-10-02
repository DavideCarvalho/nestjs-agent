import type { AiToolCtx } from './spi/tool.js';
import { type AgentStreamEvent, type AgentUiComponent } from './stream-events.js';

/**
 * Components a tool pushes through `ctx.emitUi` have to survive a durable replay without being
 * streamed or persisted twice. They do it by riding the tool step's RESULT: the step that ran the
 * tool (`tool:<callId>` in-process, or the dispatched `AgentRunSteps.tool`) returns its output
 * wrapped together with the components, the runtime journals that, and a replay reads both back
 * without running anything. The loop then persists them once, from the step that already persists
 * the step's tool results.
 *
 * The wrapper is used ONLY when a tool pushed something, so every other tool journals exactly the
 * bytes it always did, and a run recorded before this existed replays unchanged.
 */
const TOOL_STEP_UI = '@@nestjs-agent/tool-step-ui';

interface ToolStepOutputWithUi {
  [TOOL_STEP_UI]: 1;
  output: unknown;
  ui: AgentUiComponent[];
  preflightDenied?: string;
  text?: string;
}

/** The tool step's journaled result: the bare output, or the output plus the components it pushed. */
export function wrapToolStepOutput(
  output: unknown,
  ui: readonly AgentUiComponent[],
  text?: string,
): unknown {
  // Escape ordinary output that happens to match our envelope: unwrap exactly one layer.
  const reserved = typeof output === 'object' && output !== null && TOOL_STEP_UI in output;
  if (ui.length === 0 && !reserved && !text) {
    return output;
  }
  const wrapped: ToolStepOutputWithUi = {
    [TOOL_STEP_UI]: 1,
    output,
    ui: [...ui],
    ...(text ? { text } : {}),
  };
  return wrapped;
}

/** Carry domain refusal across a remote step without losing its type in error serialization. */
export function wrapToolPreflightDenied(reason: string): unknown {
  const wrapped: ToolStepOutputWithUi = {
    [TOOL_STEP_UI]: 1,
    output: null,
    ui: [],
    preflightDenied: reason,
  };
  return wrapped;
}

/** Read a tool step's result back — either shape. */
export function unwrapToolStepOutput(raw: unknown): {
  output: unknown;
  ui: AgentUiComponent[];
  preflightDenied?: string;
  text?: string;
} {
  if (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as Partial<ToolStepOutputWithUi>)[TOOL_STEP_UI] === 1
  ) {
    const wrapped = raw as ToolStepOutputWithUi;
    return {
      output: wrapped.output,
      ui: Array.isArray(wrapped.ui) ? wrapped.ui : [],
      ...(typeof wrapped.text === 'string' ? { text: wrapped.text } : {}),
      ...(typeof wrapped.preflightDenied === 'string'
        ? { preflightDenied: wrapped.preflightDenied }
        : {}),
    };
  }
  return { output: raw, ui: [] };
}

export type EmitUi = AiToolCtx['emitUi'];

/**
 * `ctx.emitUi` where there is no conversation to push into (the MCP server, a direct
 * `registry.invoke`): nothing is streamed or persisted, but the call resolves to an id — the one it
 * was given, else `<scope>:ui:<n>` — so a tool never has to test for the capability.
 */
export function createNoopEmitUi(scope = 'noop'): EmitUi {
  let next = 0;
  return async (_component, _props, options = {}) => {
    if (options.id !== undefined) {
      return { id: options.id };
    }
    const id = `${scope}:ui:${next}`;
    next += 1;
    return { id };
  };
}

/** Collects what one tool invocation pushes, streaming each push as it happens. */
export interface UiCollector {
  emit: EmitUi;
  /** Everything pushed so far: first-seen order, last props per id. */
  components(): AgentUiComponent[];
  /**
   * A new ATTEMPT of the same call (a transient retry): numbering restarts, so the retry's pushes
   * reuse — and replace — the ids the failed attempt used.
   */
  restart(): void;
}

/**
 * `write` streams one frame; omit it where there is no live stream (the component is still
 * collected and persisted).
 */
export function createUiCollector(
  toolCallId: string,
  write?: (event: AgentStreamEvent) => void | Promise<void>,
): UiCollector {
  const pushed = new Map<string, AgentUiComponent>();
  let next = 0;
  const emit: EmitUi = async (component, props, options = {}) => {
    if (typeof component !== 'string' || component.length === 0) {
      throw new Error('emitUi: component must be a non-empty string');
    }
    if (typeof props !== 'object' || props === null || Array.isArray(props)) {
      throw new Error('emitUi: props must be a JSON object');
    }
    let id = options.id;
    if (id === undefined) {
      id = `${toolCallId}:ui:${next}`;
      next += 1;
    }
    const entry: AgentUiComponent = {
      id,
      component,
      // Snapshot: the frame and the persisted value are what the tool pushed at THIS moment, not
      // whatever the object it handed over looks like when the step settles.
      props: JSON.parse(JSON.stringify(props)) as Record<string, unknown>,
      ...(options.version !== undefined ? { version: options.version } : {}),
      ...(options.fallbackText !== undefined ? { fallbackText: options.fallbackText } : {}),
      ...(options.componentVersions !== undefined
        ? { componentVersions: { ...options.componentVersions } }
        : {}),
      toolCallId,
    };
    // Delete-then-set would move it; a repeat id keeps its first position, like the client's part.
    pushed.set(id, entry);
    await write?.({ kind: 'ui', ...entry });
    return { id };
  };
  return {
    emit,
    components: () => [...pushed.values()],
    restart: () => {
      next = 0;
    },
  };
}

/** Merge component lists: first-seen order, the last props for each id. */
export function mergeUi(
  ...lists: readonly (readonly AgentUiComponent[] | undefined)[]
): AgentUiComponent[] {
  const merged = new Map<string, AgentUiComponent>();
  for (const list of lists) {
    for (const component of list ?? []) {
      merged.set(component.id, component);
    }
  }
  return [...merged.values()];
}

/** Escape code units native PostgreSQL/MySQL TEXT cannot store; retain ordinary prose and emoji. */
export function escapeUnsafeToolUiText(text: string): string {
  return text
    .replaceAll('\u0000', '\\u0000')
    .replace(
      /[\uD800-\uDFFF]/gu,
      (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
}
