import type { Segment, SegmentSource } from './types.js';

/**
 * Text slots of provider and MCP payloads, for a process that proxies them: each slot is a piece of
 * text to scan plus a setter that writes the (redacted / restored) text back in place.
 */
export interface Slot {
  segment: Segment;
  set(text: string): void;
  /** The text lives inside a JSON document (tool-call arguments): restored values are escaped. */
  json?: boolean;
}

const MAX_SLOTS = 2_000;

function sourceOf(role: unknown): SegmentSource {
  if (role === 'system' || role === 'developer') return 'system';
  if (role === 'assistant') return 'assistant';
  if (role === 'tool' || role === 'function') return 'tool';
  return 'user';
}

/** Index of the first message of the newest turn (everything after the last assistant message). */
function freshFrom(messages: any[]): number {
  for (let i = messages.length - 1; i >= 0; i--)
    if (messages[i]?.role === 'assistant') return i + 1;
  return 0;
}

/** String leaves of a JSON value (tool arguments, structured results). */
export function jsonSlots(
  root: unknown,
  source: SegmentSource,
  fresh: boolean,
  replaceRoot?: (v: string) => void,
): Slot[] {
  const out: Slot[] = [];
  const walk = (value: unknown, set: (v: string) => void, depth: number) => {
    if (out.length >= MAX_SLOTS || depth > 10) return;
    if (typeof value === 'string') {
      if (value) out.push({ segment: { text: value, source, fresh }, set });
      return;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        walk(
          value[i],
          (t) => {
            value[i] = t;
          },
          depth + 1,
        );
      }
      return;
    }
    if (value && typeof value === 'object') {
      const o = value as Record<string, unknown>;
      for (const k of Object.keys(o))
        walk(
          o[k],
          (t) => {
            o[k] = t;
          },
          depth + 1,
        );
    }
  };
  walk(root, replaceRoot ?? (() => undefined), 0);
  return out;
}

/** A JSON-encoded string (tool-call arguments) as one slot; placeholders keep it valid JSON. */
function jsonStringSlot(
  holder: Record<string, unknown>,
  key: string,
  source: SegmentSource,
  fresh: boolean,
) {
  const v = holder[key];
  if (typeof v !== 'string' || !v) return [];
  return [
    {
      segment: { text: v, source, fresh },
      set: (t: string) => {
        holder[key] = t;
      },
      json: true,
    } satisfies Slot,
  ];
}

function contentSlots(
  holder: Record<string, unknown>,
  source: SegmentSource,
  fresh: boolean,
): Slot[] {
  const content = holder.content;
  if (typeof content === 'string') {
    return content
      ? [
          {
            segment: { text: content, source, fresh },
            set: (t) => {
              holder.content = t;
            },
          },
        ]
      : [];
  }
  if (!Array.isArray(content)) return [];
  const out: Slot[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const p = part as Record<string, unknown>;
    if (
      (p.type === 'text' || p.type === 'input_text' || p.type === 'output_text') &&
      typeof p.text === 'string'
    ) {
      out.push({
        segment: { text: p.text, source, fresh },
        set: (t) => {
          p.text = t;
        },
      });
    } else if (p.type === 'tool_result') {
      // Anthropic: results of the client's tools flowing back into the model.
      out.push(...contentSlots(p, 'tool', fresh));
    } else if (p.type === 'tool_use' && p.input && typeof p.input === 'object') {
      out.push(...jsonSlots(p.input, 'assistant', fresh));
    }
  }
  return out;
}

/** Slots of an LLM request body: OpenAI chat completions, Anthropic Messages or embeddings. */
export function requestSlots(api: 'openai' | 'anthropic', body: Record<string, unknown>): Slot[] {
  const out: Slot[] = [];
  if (api === 'anthropic') {
    if (typeof body.system === 'string' && body.system) {
      out.push({
        segment: { text: body.system, source: 'system', fresh: true },
        set: (t) => {
          body.system = t;
        },
      });
    } else if (Array.isArray(body.system)) {
      out.push(
        ...contentSlots({ content: body.system } as Record<string, unknown>, 'system', true),
      );
    }
  }
  if (Array.isArray(body.messages)) {
    const messages = body.messages as any[];
    const from = freshFrom(messages);
    messages.forEach((m, i) => {
      if (!m || typeof m !== 'object') return;
      const fresh = i >= from || m.role === 'system';
      const source = sourceOf(m.role);
      out.push(...contentSlots(m, source, fresh));
      if (Array.isArray(m.tool_calls)) {
        for (const call of m.tool_calls)
          if (call?.function)
            out.push(...jsonStringSlot(call.function, 'arguments', 'assistant', fresh));
      }
    });
  }
  // Embeddings: `input` is a string or a list of strings.
  if (typeof body.input === 'string' || Array.isArray(body.input)) {
    const holder = body as Record<string, unknown>;
    if (typeof holder.input === 'string') {
      out.push({
        segment: { text: holder.input, source: 'user', fresh: true },
        set: (t) => {
          holder.input = t;
        },
      });
    } else {
      const list = holder.input as unknown[];
      list.forEach((v, i) => {
        if (typeof v === 'string' && v)
          out.push({
            segment: { text: v, source: 'user', fresh: true },
            set: (t) => {
              list[i] = t;
            },
          });
      });
    }
  }
  return out.slice(0, MAX_SLOTS);
}

/** Slots of a non-streaming answer in the caller's format (OpenAI chat completion or Anthropic message). */
export function responseSlots(api: 'openai' | 'anthropic', body: unknown): Slot[] {
  if (!body || typeof body !== 'object') return [];
  const b = body as Record<string, any>;
  const out: Slot[] = [];
  if (api === 'anthropic') {
    if (Array.isArray(b.content)) out.push(...contentSlots(b, 'assistant', true));
    return out;
  }
  for (const choice of Array.isArray(b.choices) ? b.choices : []) {
    const msg = choice?.message;
    if (!msg || typeof msg !== 'object') continue;
    out.push(...contentSlots(msg, 'assistant', true));
    if (Array.isArray(msg.tool_calls))
      for (const call of msg.tool_calls)
        if (call?.function)
          out.push(...jsonStringSlot(call.function, 'arguments', 'assistant', true));
  }
  return out;
}

/** Replaces the answer of a non-streaming response with a refusal (finish reason content_filter). */
export function refuseResponse(
  api: 'openai' | 'anthropic',
  body: unknown,
  message: string,
): unknown {
  if (!body || typeof body !== 'object') return body;
  const b = body as Record<string, any>;
  if (api === 'anthropic') {
    return { ...b, content: [{ type: 'text', text: message }], stop_reason: 'refusal' };
  }
  return {
    ...b,
    choices: (Array.isArray(b.choices) && b.choices.length > 0 ? b.choices : [{ index: 0 }]).map(
      (c: any) => ({
        ...c,
        message: { role: 'assistant', content: message },
        finish_reason: 'content_filter',
      }),
    ),
  };
}

/** Slots of an MCP tool result: text content, embedded text resources and structured content. */
export function toolResultSlots(result: Record<string, unknown>): Slot[] {
  const out: Slot[] = [];
  if (Array.isArray(result.content)) {
    for (const item of result.content as any[]) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'text' && typeof item.text === 'string') {
        out.push({
          segment: { text: item.text, source: 'tool', fresh: true },
          set: (t) => {
            item.text = t;
          },
        });
      } else if (
        item.type === 'resource' &&
        item.resource &&
        typeof item.resource.text === 'string'
      ) {
        out.push({
          segment: { text: item.resource.text, source: 'tool', fresh: true },
          set: (t) => {
            item.resource.text = t;
          },
        });
      }
    }
  }
  if (result.structuredContent && typeof result.structuredContent === 'object')
    out.push(...jsonSlots(result.structuredContent, 'tool', true));
  return out.slice(0, MAX_SLOTS);
}
