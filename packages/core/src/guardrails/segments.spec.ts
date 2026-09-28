import { describe, expect, it } from 'vitest';
import { requestSlots, responseSlots, toolResultSlots } from './segments.js';

describe('segments', () => {
  it('OpenAI requests: every message, tool results and tool-call arguments; fresh = the newest turn', () => {
    const body = {
      messages: [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'old question' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: '1', function: { name: 'f', arguments: '{"q":"x"}' } }],
        },
        { role: 'tool', tool_call_id: '1', content: 'tool said hi' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'new question' },
            { type: 'image_url', image_url: { url: 'data:,' } },
          ],
        },
      ],
    };
    const slots = requestSlots('openai', body);
    expect(slots.map((s) => [s.segment.source, s.segment.text, s.segment.fresh])).toEqual([
      ['system', 'You are helpful', true],
      ['user', 'old question', false],
      ['assistant', '{"q":"x"}', false],
      ['tool', 'tool said hi', true],
      ['user', 'new question', true],
    ]);
    slots[4]?.set('rewritten');
    expect((body.messages[4]?.content as any)[0].text).toBe('rewritten');
  });

  it('Anthropic requests: system blocks and tool_result blocks', () => {
    const body = {
      system: [{ type: 'text', text: 'sys' }],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't',
              content: [{ type: 'text', text: 'mail body' }],
            },
          ],
        },
      ],
    };
    const slots = requestSlots('anthropic', body);
    expect(slots.map((s) => [s.segment.source, s.segment.text])).toEqual([
      ['system', 'sys'],
      ['tool', 'mail body'],
    ]);
  });

  it('embeddings input and responses in both formats', () => {
    expect(requestSlots('openai', { input: ['a', 'b'] }).map((s) => s.segment.text)).toEqual([
      'a',
      'b',
    ]);
    const openai = {
      choices: [
        { message: { content: 'hi', tool_calls: [{ function: { arguments: '{"to":"x"}' } }] } },
      ],
    };
    expect(responseSlots('openai', openai).map((s) => [s.segment.text, !!s.json])).toEqual([
      ['hi', false],
      ['{"to":"x"}', true],
    ]);
    const anthropic = {
      content: [
        { type: 'text', text: 'hello' },
        { type: 'tool_use', input: { to: 'y' } },
      ],
    };
    expect(responseSlots('anthropic', anthropic).map((s) => s.segment.text)).toEqual([
      'hello',
      'y',
    ]);
  });

  it('MCP tool results: text, embedded resources and structured content', () => {
    const result = {
      content: [
        { type: 'text', text: 'a' },
        { type: 'image', data: '…', mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 'x', text: 'b' } },
      ],
      structuredContent: { items: [{ body: 'c' }] },
    };
    const slots = toolResultSlots(result);
    expect(slots.map((s) => s.segment.text)).toEqual(['a', 'b', 'c']);
    slots[2]?.set('C');
    expect(result.structuredContent.items[0]?.body).toBe('C');
  });
});
