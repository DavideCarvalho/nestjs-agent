import { parsePartialJson } from './partial-json.js';
import type { ShownToolInputPreview } from './spi/model-provider.js';
import type { SinkWriter } from './spi/token-stream-sink.js';
import type { ToolDescribeScope, ToolInputPreview, ToolInputPreviewScope } from './spi/tool.js';
import { type AgentStreamEvent, decodeStreamEvent, encodeStreamEvent } from './stream-events.js';

/** Default least time between two preview frames of one call ({@link ToolInputPreview.throttleMs}). */
export const DEFAULT_PREVIEW_THROTTLE_MS = 100;

/** The id a call's preview is shown under: the one its first `ctx.emitUi` push gets. */
export function previewUiId(toolCallId: string): string {
  return `${toolCallId}:ui:0`;
}

/** The event that withdraws a preview: partial, with nothing to draw. */
export function withdrawPreviewEvent(shown: ShownToolInputPreview): AgentStreamEvent {
  return {
    kind: 'ui',
    id: shown.id,
    component: shown.component,
    props: {},
    toolCallId: shown.toolCallId,
    partial: true,
  };
}

interface CallState {
  preview: ToolInputPreview;
  text: string;
  /** When the last preview frame was written; `undefined` before the first. */
  lastAt: number | undefined;
  /** The props last written, serialized: an unchanged preview is not written again. */
  lastProps: string | undefined;
  component: string | undefined;
  stopped: boolean;
}

export interface ToolInputPreviews {
  /** Hand THIS to the model provider: every chunk passes through, previews are added after. */
  writer: SinkWriter;
  /** The previews still standing (shown and not withdrawn), in the order they first appeared. */
  shown(): ShownToolInputPreview[];
}

/**
 * Wrap the writer a model turn streams into so a tool that previews its input
 * (`ToolHandler.previewInput`) gets `ui` frames drawn from the arguments while the model writes them.
 *
 * Per call: the streamed argument text (`tool-input-delta`) is accumulated, parsed as far as it goes
 * (`parsePartialJson`) and handed to the preview; what it renders is written as a `partial` `ui`
 * frame — at most one every `throttleMs`, and only when it changed, so a long tree costs the stream
 * (and every sink buffering it) a bounded number of snapshots rather than one per delta. Whatever the
 * throttle held back is flushed when the arguments are complete (`tool-input-available`).
 *
 * Previews never fail the turn: a preview that throws is dropped for that call.
 */
export function previewToolInputs(
  inner: SinkWriter,
  resolve: (toolName: string, toolCallId: string) => Promise<ToolInputPreview | undefined>,
  now: () => number = Date.now,
): ToolInputPreviews {
  const calls = new Map<string, CallState>();
  const shown = new Map<string, ShownToolInputPreview>();
  const decoder = new TextDecoder();
  let pending = '';

  async function emit(id: string, state: CallState, input: unknown, done: boolean): Promise<void> {
    let rendered: ReturnType<ToolInputPreview['render']>;
    try {
      const parsed =
        done && input !== undefined
          ? { value: input, complete: true, isOpen: () => false, pendingMember: () => undefined }
          : parsePartialJson(state.text);
      if (parsed === undefined) return;
      rendered = state.preview.render({
        value: parsed.value,
        done: done || parsed.complete,
        isOpen: parsed.isOpen,
        pendingMember: parsed.pendingMember,
      });
    } catch {
      rendered = null;
    }
    if (rendered === undefined) return;
    const uiId = previewUiId(id);
    if (rendered === null) {
      state.stopped = true;
      const standing = shown.get(uiId);
      if (standing !== undefined) {
        shown.delete(uiId);
        await inner.write(encodeStreamEvent(withdrawPreviewEvent(standing)));
      }
      return;
    }
    const props = JSON.stringify(rendered.props);
    if (props === state.lastProps && rendered.component === state.component) return;
    state.lastProps = props;
    state.component = rendered.component;
    state.lastAt = now();
    shown.set(uiId, { id: uiId, component: rendered.component, toolCallId: id });
    await inner.write(
      encodeStreamEvent({
        kind: 'ui',
        id: uiId,
        component: rendered.component,
        props: JSON.parse(props) as Record<string, unknown>,
        ...(rendered.version !== undefined ? { version: rendered.version } : {}),
        toolCallId: id,
        partial: true,
      }),
    );
  }

  async function observe(event: AgentStreamEvent): Promise<void> {
    if (event.kind === 'tool-input-start') {
      if (calls.has(event.id)) return;
      let preview: ToolInputPreview | undefined;
      try {
        preview = await resolve(event.name, event.id);
      } catch {
        preview = undefined;
      }
      if (preview !== undefined) {
        calls.set(event.id, {
          preview,
          text: '',
          lastAt: undefined,
          lastProps: undefined,
          component: undefined,
          stopped: false,
        });
      }
      return;
    }
    if (event.kind === 'tool-input-delta') {
      const state = calls.get(event.id);
      if (state === undefined || state.stopped) return;
      state.text += event.delta;
      const throttle = state.preview.throttleMs ?? DEFAULT_PREVIEW_THROTTLE_MS;
      if (state.lastAt !== undefined && now() - state.lastAt < throttle) return;
      await emit(event.id, state, undefined, false);
      return;
    }
    if (event.kind === 'tool-input-available') {
      const state = calls.get(event.id);
      if (state === undefined) return;
      calls.delete(event.id);
      if (state.stopped) return;
      // The whole input, at once: what the throttle held back, and the closing brackets.
      await emit(event.id, state, event.input, true);
    }
  }

  return {
    writer: {
      async write(chunk) {
        await inner.write(chunk);
        pending += decoder.decode(chunk, { stream: true });
        let newline = pending.indexOf('\n');
        while (newline !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          const event = line.trim().length > 0 ? decodeStreamEvent(line) : null;
          if (event !== null) await observe(event);
          newline = pending.indexOf('\n');
        }
      },
      end: () => inner.end(),
      fail: (error) => inner.fail(error),
    },
    shown: () => [...shown.values()],
  };
}

/**
 * The resolver {@link previewToolInputs} takes, over a registry: a call of a tool this turn OFFERED
 * is previewed as its handler's `previewInput` says, for the turn's scope; any other name (a tool the
 * model was not shown, a built-in like `ask`) is not previewed.
 */
export function registryInputPreviews(
  registry: {
    previewInput(name: string, scope: ToolInputPreviewScope): Promise<ToolInputPreview | undefined>;
  },
  offered: readonly { name: string }[],
  scope: ToolDescribeScope,
): (toolName: string, toolCallId: string) => Promise<ToolInputPreview | undefined> {
  const names = new Set(offered.map((tool) => tool.name));
  return async (toolName, toolCallId) =>
    names.has(toolName) ? registry.previewInput(toolName, { ...scope, toolCallId }) : undefined;
}
