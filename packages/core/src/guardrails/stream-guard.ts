import { resolveOverlaps } from './engine.js';
import type { Finding } from './types.js';
import type { Vault } from './vault.js';

/**
 * Guards a streamed answer in the caller's format (OpenAI chat-completion chunks or Anthropic
 * Messages events). Text deltas are buffered per channel (the answer text, each tool call's
 * arguments, each content block) and released in windows: the newest `holdback` characters stay
 * buffered so a value split across deltas ("4111 1111" … "1111 1111") is seen whole, and a window
 * never ends inside something a detector found or inside a placeholder being restored. Each
 * released window is scanned (redaction, moderation…) and has placeholders restored. When a
 * window is blocked the stream ends with the rule's message and a `content_filter` / `refusal`
 * finish; the rest of the upstream is consumed (for usage) but not forwarded.
 */
export interface WindowVerdict {
  /** Text to release (redacted). */
  text: string;
  block?: { message: string };
}

export interface StreamGuardOptions {
  api: 'openai' | 'anthropic';
  vault: Vault;
  /** Restore placeholders from the request's redactions into what the caller receives. */
  restore: boolean;
  /** Response-stage scan of one window; undefined when no response rule applies. */
  scan?: (text: string, channel: string) => Promise<WindowVerdict>;
  /** Spans (local detectors) a window must not cut through. */
  locate?: (text: string) => Finding[];
  /** Characters released per window (default 256). */
  window?: number;
  /** Characters kept back at the end of the buffer (default 64). */
  holdback?: number;
}

class Channel {
  pending = '';
  constructor(readonly json: boolean) {}
}

type Frame = { event?: string | undefined; data: string; raw: string };

export class StreamGuard {
  private buffer = '';
  private readonly decoder = new TextDecoder();
  private readonly channels = new Map<string, Channel>();
  private readonly window: number;
  private readonly holdback: number;
  blocked?: { message: string };
  private template: Record<string, unknown> | undefined;
  private readonly openBlocks = new Set<number>();
  private maxBlock = -1;
  private done = false;

  constructor(private readonly opts: StreamGuardOptions) {
    this.window = opts.window ?? 256;
    this.holdback = opts.holdback ?? 64;
  }

  /** Whether the guard changes anything (else the caller can pass bytes straight through). */
  get active(): boolean {
    return !!this.opts.scan || (this.opts.restore && this.opts.vault.restorableCount > 0);
  }

  async push(chunk: string | Uint8Array): Promise<string> {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    let out = '';
    for (;;) {
      const m = /\r?\n\r?\n/.exec(this.buffer);
      if (!m) break;
      const raw = this.buffer.slice(0, m.index + m[0].length);
      this.buffer = this.buffer.slice(m.index + m[0].length);
      out += await this.frame(parseFrame(raw));
    }
    return out;
  }

  async end(): Promise<string> {
    let out = '';
    if (this.buffer.trim()) out += await this.frame(parseFrame(`${this.buffer}\n\n`));
    this.buffer = '';
    if (!this.blocked && !this.done) out += await this.flushAll();
    return out;
  }

  private async frame(f: Frame): Promise<string> {
    if (this.blocked) return '';
    if (this.opts.api === 'openai') return this.openaiFrame(f);
    return this.anthropicFrame(f);
  }

  // ---- OpenAI chat-completion chunks ---------------------------------------------------------

  private async openaiFrame(f: Frame): Promise<string> {
    if (!f.data) return f.raw;
    if (f.data.trim() === '[DONE]') {
      const tail = await this.flushAll();
      this.done = true;
      return tail + f.raw;
    }
    let chunk: any;
    try {
      chunk = JSON.parse(f.data);
    } catch {
      return f.raw;
    }
    this.template ??= {
      id: chunk.id,
      object: chunk.object,
      created: chunk.created,
      model: chunk.model,
    };
    if (!Array.isArray(chunk.choices) || chunk.choices.length === 0) return f.raw;
    let prefix = '';
    let keep = false;
    for (const choice of chunk.choices) {
      const delta = choice.delta ?? {};
      const ci = choice.index ?? 0;
      if (typeof delta.content === 'string' && delta.content) {
        const r = await this.feed(`c:${ci}`, delta.content, false);
        if (this.blocked) return prefix + this.openaiBlock(ci);
        delta.content = r;
        if (r) keep = true;
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          const fn = call.function;
          if (fn && typeof fn.arguments === 'string' && fn.arguments) {
            const r = await this.feed(`t:${ci}:${call.index ?? 0}`, fn.arguments, true);
            if (this.blocked) return prefix + this.openaiBlock(ci);
            fn.arguments = r;
          }
          if (call.id || fn?.name || fn?.arguments) keep = true;
        }
      }
      if (delta.role || delta.reasoning_content || delta.refusal) keep = true;
      if (choice.finish_reason) {
        // Everything buffered for this choice goes out before its finish.
        prefix += await this.flushChoice(ci);
        if (this.blocked) return prefix + this.openaiBlock(ci);
        keep = true;
      }
    }
    if (chunk.usage) keep = true;
    return keep ? `${prefix}data: ${JSON.stringify(chunk)}\n\n` : prefix;
  }

  private openaiChunk(
    ci: number,
    delta: Record<string, unknown>,
    finish: string | null = null,
  ): string {
    return `data: ${JSON.stringify({
      ...(this.template ?? { object: 'chat.completion.chunk' }),
      choices: [{ index: ci, delta, finish_reason: finish }],
    })}\n\n`;
  }

  private openaiBlock(ci: number): string {
    const msg = this.blocked?.message ?? '';
    this.done = true;
    return `${this.openaiChunk(ci, { content: `\n\n${msg}` })}${this.openaiChunk(ci, {}, 'content_filter')}data: [DONE]\n\n`;
  }

  private async flushChoice(ci: number): Promise<string> {
    let out = '';
    for (const [key, ch] of this.channels) {
      if (!key.startsWith(`c:${ci}`) && !key.startsWith(`t:${ci}:`)) continue;
      const text = await this.release(key, ch, true);
      if (this.blocked) return out;
      if (!text) continue;
      out += key.startsWith('c:')
        ? this.openaiChunk(ci, { content: text })
        : this.openaiChunk(ci, {
            tool_calls: [{ index: Number(key.split(':')[2]), function: { arguments: text } }],
          });
    }
    return out;
  }

  // ---- Anthropic Messages events -------------------------------------------------------------

  private async anthropicFrame(f: Frame): Promise<string> {
    if (!f.data) return f.raw;
    let ev: any;
    try {
      ev = JSON.parse(f.data);
    } catch {
      return f.raw;
    }
    const type = ev.type ?? f.event;
    if (type === 'content_block_start') {
      this.openBlocks.add(ev.index);
      this.maxBlock = Math.max(this.maxBlock, ev.index);
      return f.raw;
    }
    if (type === 'content_block_delta') {
      const d = ev.delta ?? {};
      if (d.type === 'text_delta' && typeof d.text === 'string') {
        const r = await this.feed(`b:${ev.index}`, d.text, false);
        if (this.blocked) return this.anthropicBlock(ev.index);
        if (!r) return '';
        d.text = r;
        return sseEvent('content_block_delta', ev);
      }
      if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
        const r = await this.feed(`b:${ev.index}`, d.partial_json, true);
        if (this.blocked) return this.anthropicBlock(ev.index);
        if (!r) return '';
        d.partial_json = r;
        return sseEvent('content_block_delta', ev);
      }
      return f.raw;
    }
    if (type === 'content_block_stop') {
      const pre = await this.flushBlock(ev.index);
      if (this.blocked) return pre + this.anthropicBlock(ev.index);
      this.openBlocks.delete(ev.index);
      return pre + f.raw;
    }
    if (type === 'message_delta' || type === 'message_stop') {
      let pre = '';
      for (const i of [...this.openBlocks]) {
        pre += await this.flushBlock(i);
        if (this.blocked) return pre + this.anthropicBlock(i);
      }
      if (type === 'message_stop') this.done = true;
      return pre + f.raw;
    }
    return f.raw;
  }

  private async flushBlock(index: number): Promise<string> {
    const key = `b:${index}`;
    const ch = this.channels.get(key);
    if (!ch) return '';
    const text = await this.release(key, ch, true);
    if (this.blocked || !text) return '';
    return sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: ch.json
        ? { type: 'input_json_delta', partial_json: text }
        : { type: 'text_delta', text },
    });
  }

  private anthropicBlock(index: number): string {
    const msg = this.blocked?.message ?? '';
    this.done = true;
    let out = '';
    let i = index;
    const ch = this.channels.get(`b:${index}`);
    if (!this.openBlocks.has(index) || ch?.json) {
      if (this.openBlocks.has(index))
        out += sseEvent('content_block_stop', { type: 'content_block_stop', index });
      i = this.maxBlock + 1;
      out += sseEvent('content_block_start', {
        type: 'content_block_start',
        index: i,
        content_block: { type: 'text', text: '' },
      });
    }
    out += sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: i,
      delta: { type: 'text_delta', text: `\n\n${msg}` },
    });
    out += sseEvent('content_block_stop', { type: 'content_block_stop', index: i });
    out += sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'refusal', stop_sequence: null },
      usage: { output_tokens: 0 },
    });
    out += sseEvent('message_stop', { type: 'message_stop' });
    return out;
  }

  // ---- windows -------------------------------------------------------------------------------

  private async flushAll(): Promise<string> {
    if (this.opts.api === 'openai') {
      const choices = new Set([...this.channels.keys()].map((k) => Number(k.split(':')[1])));
      let out = '';
      for (const ci of choices) {
        out += await this.flushChoice(ci);
        if (this.blocked) return out + this.openaiBlock(ci);
      }
      return out;
    }
    let out = '';
    for (const i of [...this.openBlocks]) {
      out += await this.flushBlock(i);
      if (this.blocked) return out + this.anthropicBlock(i);
    }
    return out;
  }

  private async feed(key: string, text: string, json: boolean): Promise<string> {
    let ch = this.channels.get(key);
    if (!ch) {
      ch = new Channel(json);
      this.channels.set(key, ch);
    }
    ch.pending += text;
    if (ch.pending.length < this.window + this.holdback) return '';
    return this.release(key, ch, false);
  }

  /** Releases a window (everything when `all`), scanned and restored. */
  private async release(key: string, ch: Channel, all: boolean): Promise<string> {
    if (!ch.pending) return '';
    let cut = all ? ch.pending.length : ch.pending.length - this.holdback;
    if (!all) {
      // Never cut through a finding or a placeholder.
      // Spans are non-overlapping, so at most one straddles the cut. A span that reaches the end of
      // the buffer may still be growing (a private key block): wait for more.
      const spans = resolveOverlaps(this.opts.locate?.(ch.pending) ?? []);
      const straddling = spans.find((f) => f.start < cut && f.end > cut);
      if (straddling) cut = straddling.end < ch.pending.length ? straddling.end : straddling.start;
      const head = ch.pending.slice(0, cut);
      cut -= this.opts.vault.pendingPrefix(head);
      if (cut <= 0) return '';
    }
    let text = ch.pending.slice(0, cut);
    ch.pending = ch.pending.slice(cut);
    if (this.opts.scan) {
      const verdict = await this.opts.scan(text, key);
      if (verdict.block) {
        this.blocked = verdict.block;
        return '';
      }
      text = verdict.text;
    }
    return this.opts.restore ? this.opts.vault.restore(text, ch.json) : text;
  }
}

function parseFrame(raw: string): Frame {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  return { event, data: data.join('\n'), raw };
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
