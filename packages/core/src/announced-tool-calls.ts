import type { SinkWriter } from './spi/token-stream-sink.js';
import { decodeStreamEvent, encodeStreamEvent } from './stream-events.js';
import type { ToolCallRequest, ToolDefinition } from './types.js';

/**
 * Wrap the writer a model turn streams into, noting which tool calls it announced
 * (`tool-input-start` / `tool-input-available`), so the loop can announce the rest itself once the
 * turn returns. A provider that streams only text — a custom one, a test double — would otherwise
 * leave its calls unannounced: a reader of the stream sees a call's outcome (`tool-output-error`,
 * `approval-requested`) for a call it never saw, and cannot tell which tool it was — the React
 * transport drops the message, a personal agent's turn cannot attribute a refused call to the
 * scope it lacked. The same wrapper as `@adonis-agora/agent`'s loop.
 */
export function announcedToolCalls(inner: SinkWriter): {
  writer: SinkWriter;
  announceRest(calls: readonly ToolCallRequest[], tools: readonly ToolDefinition[]): Promise<void>;
} {
  const seen = new Set<string>();
  const decoder = new TextDecoder();
  let pending = '';
  const note = (line: string) => {
    if (!line.includes('"tool-input-')) return;
    // Bare text has no line end of its own, so an event written after it shares its line.
    const at = line.indexOf('{"kind":');
    const event = at === -1 ? null : decodeStreamEvent(line.slice(at));
    if (event?.kind === 'tool-input-start' || event?.kind === 'tool-input-available') {
      seen.add(event.id);
    }
  };
  const writer: SinkWriter = {
    write: (chunk) => {
      pending += decoder.decode(chunk, { stream: true });
      let newline = pending.indexOf('\n');
      while (newline !== -1) {
        note(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
      // Bare text carries no line end: a long run of it must not grow the buffer.
      const at = pending.lastIndexOf('{"kind":');
      pending = at === -1 ? '' : pending.slice(at);
      return inner.write(chunk);
    },
    end: () => inner.end(),
    fail: (error) => inner.fail(error),
    ...(inner.flush !== undefined ? { flush: () => inner.flush?.() } : {}),
  };
  return {
    writer,
    async announceRest(calls, tools) {
      for (const call of calls) {
        if (seen.has(call.id)) continue;
        seen.add(call.id);
        const kind = call.kind ?? tools.find((definition) => definition.name === call.name)?.kind;
        await inner.write(
          encodeStreamEvent({
            kind: 'tool-input-available',
            id: call.id,
            name: call.name,
            input: call.input,
            toolKind: kind === 'action' ? 'action' : 'read',
          }),
        );
      }
    },
  };
}
