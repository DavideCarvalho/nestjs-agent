import { describe, expect, it } from 'vitest';
import { detectPii } from './detectors/pii.js';
import { scan } from './engine.js';
import { StreamGuard, type StreamGuardOptions } from './stream-guard.js';
import type { GuardrailRule } from './types.js';
import { Vault } from './vault.js';

const CARD = '4111 1111 1111 1111';

/** OpenAI chat-completion chunks for `pieces`, then finish, usage and [DONE]. */
function openaiStream(pieces: string[]): string[] {
  const base = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm' };
  const frame = (o: object) => `data: ${JSON.stringify({ ...base, ...o })}\n\n`;
  return [
    frame({
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    }),
    ...pieces.map((p) =>
      frame({ choices: [{ index: 0, delta: { content: p }, finish_reason: null }] }),
    ),
    frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    frame({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }),
    'data: [DONE]\n\n',
  ];
}

function anthropicStream(pieces: string[]): string[] {
  const ev = (type: string, o: object) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`;
  return [
    ev('message_start', {
      message: { id: 'm', content: [], usage: { input_tokens: 1, output_tokens: 1 } },
    }),
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    ...pieces.map((text) =>
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }),
    ),
    ev('content_block_stop', { index: 0 }),
    ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }),
    ev('message_stop', {}),
  ];
}

async function run(guard: StreamGuard, frames: string[], split = false): Promise<string> {
  let out = '';
  for (const f of frames) {
    if (split) {
      // Re-chunk arbitrarily (passthrough upstreams split frames mid-way).
      for (let i = 0; i < f.length; i += 7)
        out += await guard.push(new TextEncoder().encode(f.slice(i, i + 7)));
    } else out += await guard.push(f);
  }
  return out + (await guard.end());
}

function openaiText(sse: string): {
  text: string;
  finish: string[];
  usage: boolean;
  done: boolean;
} {
  let text = '';
  const finish: string[] = [];
  let usage = false;
  let done = false;
  for (const block of sse.split('\n\n')) {
    const data = block.replace(/^data: /, '').trim();
    if (!data) continue;
    if (data === '[DONE]') {
      done = true;
      continue;
    }
    const o = JSON.parse(data);
    if (o.usage) usage = true;
    for (const c of o.choices ?? []) {
      text += c.delta?.content ?? '';
      if (c.finish_reason) finish.push(c.finish_reason);
    }
  }
  return { text, finish, usage, done };
}

function anthropicText(sse: string): { text: string; stop: string | undefined; events: string[] } {
  let text = '';
  let stop: string | undefined;
  const events: string[] = [];
  for (const block of sse.split('\n\n')) {
    const data = /data: (.*)/.exec(block)?.[1];
    if (!data) continue;
    const o = JSON.parse(data);
    events.push(o.type);
    if (o.type === 'content_block_delta' && o.delta.type === 'text_delta') text += o.delta.text;
    if (o.type === 'message_delta') stop = o.delta.stop_reason;
  }
  return { text, stop, events };
}

const redactRule: GuardrailRule = {
  id: 'r',
  name: 'redact cards',
  priority: 1,
  enabled: true,
  stages: ['llm_response'],
  detectors: [{ kind: 'pii', types: ['credit_card', 'email'] }],
  action: 'redact',
  match: {},
  options: {},
};

function responseScan(
  rules: GuardrailRule[],
  vault: Vault,
): NonNullable<StreamGuardOptions['scan']> {
  return async (text) => {
    const r = await scan(rules, { stage: 'llm_response' }, [{ text }], vault);
    if (r.action === 'block') return { text: '', block: { message: r.decisive?.message ?? '' } };
    return { text: r.segments[0] ?? text };
  };
}

describe('StreamGuard (OpenAI chunks)', () => {
  it('redacts a card number split across deltas, keeps finish, usage and [DONE]', async () => {
    const vault = new Vault();
    const guard = new StreamGuard({
      api: 'openai',
      vault,
      restore: false,
      scan: responseScan([redactRule], vault),
      locate: (t) => detectPii(t, ['credit_card', 'email']),
      window: 16,
      holdback: 32,
    });
    const answer = `Sure. The card on file is ${CARD} and the contact is ana@acme.com. Anything else?`;
    const pieces = answer.match(/.{1,5}/gs) ?? [];
    const out = openaiText(await run(guard, openaiStream(pieces)));
    expect(out.text).toBe(
      'Sure. The card on file is [REDACTED_CREDIT_CARD_1] and the contact is [REDACTED_EMAIL_1]. Anything else?',
    );
    expect(out.finish).toEqual(['stop']);
    expect(out.usage).toBe(true);
    expect(out.done).toBe(true);
  });

  it('works when the transport splits SSE frames mid-way', async () => {
    const vault = new Vault();
    const guard = new StreamGuard({
      api: 'openai',
      vault,
      restore: false,
      scan: responseScan([redactRule], vault),
      locate: (t) => detectPii(t, ['credit_card']),
      window: 8,
      holdback: 32,
    });
    const out = openaiText(
      await run(guard, openaiStream(['card: 4111 11', '11 1111 1111 done']), true),
    );
    expect(out.text).toBe('card: [REDACTED_CREDIT_CARD_1] done');
  });

  it("restores the request's placeholders even when split across deltas", async () => {
    const vault = new Vault();
    vault.tokenFor('EMAIL', 'ana@acme.com', true);
    vault.tokenFor('CPF', '529.982.247-25', true);
    const guard = new StreamGuard({ api: 'openai', vault, restore: true, window: 4, holdback: 16 });
    expect(guard.active).toBe(true);
    const out = openaiText(
      await run(guard, openaiStream(['Email [EMA', 'IL_1] and CPF [C', 'PF_1]; [OTHER_1] stays'])),
    );
    expect(out.text).toBe('Email ana@acme.com and CPF 529.982.247-25; [OTHER_1] stays');
  });

  it('restores inside streamed tool-call arguments (JSON-escaped)', async () => {
    const vault = new Vault();
    vault.tokenFor('NOTE', 'say "hi"', true);
    const guard = new StreamGuard({ api: 'openai', vault, restore: true, window: 4, holdback: 16 });
    const base = { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm' };
    const frame = (delta: object, finish: string | null = null) =>
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const frames = [
      frame({
        tool_calls: [
          { index: 0, id: 'call_1', type: 'function', function: { name: 'note', arguments: '' } },
        ],
      }),
      frame({ tool_calls: [{ index: 0, function: { arguments: '{"text":"[NO' } }] }),
      frame({ tool_calls: [{ index: 0, function: { arguments: 'TE_1]"}' } }] }),
      frame({}, 'tool_calls'),
      'data: [DONE]\n\n',
    ];
    const sse = await run(guard, frames);
    let args = '';
    for (const block of sse.split('\n\n')) {
      const d = block.replace(/^data: /, '').trim();
      if (!d || d === '[DONE]') continue;
      for (const c of JSON.parse(d).choices ?? [])
        for (const t of c.delta?.tool_calls ?? []) args += t.function?.arguments ?? '';
    }
    expect(JSON.parse(args)).toEqual({ text: 'say "hi"' });
    expect(sse).toContain('"id":"call_1"');
  });

  it('blocks mid-stream: rule message, content_filter finish, nothing after', async () => {
    const vault = new Vault();
    const block: GuardrailRule = {
      ...redactRule,
      action: 'block',
      options: { message: 'Withheld: card number.' },
    };
    const guard = new StreamGuard({
      api: 'openai',
      vault,
      restore: false,
      scan: responseScan([block], vault),
      locate: (t) => detectPii(t, ['credit_card']),
      window: 8,
      holdback: 32,
    });
    const out = openaiText(
      await run(guard, openaiStream(['Here it is: ', '4111 1111 ', '1111 1111', ' and more text'])),
    );
    expect(out.text).not.toContain('4111');
    expect(out.text).toContain('Withheld: card number.');
    expect(out.finish).toEqual(['content_filter']);
    expect(out.done).toBe(true);
    expect(guard.blocked?.message).toBe('Withheld: card number.');
  });

  it('passes unrelated frames through untouched when there is nothing to do', async () => {
    const guard = new StreamGuard({
      api: 'openai',
      vault: new Vault(),
      restore: false,
      window: 4,
      holdback: 4,
    });
    expect(guard.active).toBe(false);
    const frames = openaiStream(['hello ', 'world']);
    const out = openaiText(await run(guard, frames));
    expect(out.text).toBe('hello world');
  });
});

describe('StreamGuard (Anthropic events)', () => {
  it('redacts across text deltas and keeps the event sequence', async () => {
    const vault = new Vault();
    const guard = new StreamGuard({
      api: 'anthropic',
      vault,
      restore: false,
      scan: responseScan([redactRule], vault),
      locate: (t) => detectPii(t, ['credit_card', 'email']),
      window: 8,
      holdback: 32,
    });
    const out = anthropicText(
      await run(guard, anthropicStream(['Card ', '4111 1111 11', '11 1111 ok'])),
    );
    expect(out.text).toBe('Card [REDACTED_CREDIT_CARD_1] ok');
    expect(out.stop).toBe('end_turn');
    expect(out.events.at(-1)).toBe('message_stop');
  });

  it('blocks with a refusal stop reason', async () => {
    const vault = new Vault();
    const guard = new StreamGuard({
      api: 'anthropic',
      vault,
      restore: false,
      scan: responseScan(
        [{ ...redactRule, action: 'block', options: { message: 'Nope.' } }],
        vault,
      ),
      locate: (t) => detectPii(t, ['credit_card']),
      window: 4,
      holdback: 32,
    });
    const out = anthropicText(await run(guard, anthropicStream([`x ${CARD} y`, ' more'])));
    expect(out.text).toContain('Nope.');
    expect(out.text).not.toContain('4111');
    expect(out.stop).toBe('refusal');
    expect(out.events.filter((e) => e === 'message_stop')).toHaveLength(1);
  });
});
