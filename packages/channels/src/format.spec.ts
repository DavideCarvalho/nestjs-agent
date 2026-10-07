import type { ElicitationQuestion } from '@dudousxd/nestjs-agent-core';
import { describe, expect, it } from 'vitest';
import {
  escapeTelegramMarkdown,
  formatChannelQuestion,
  parseChannelAnswer,
  splitMessage,
  toChannelMarkdown,
  unescapeTelegramMarkdown,
} from './index.js';

describe('toChannelMarkdown', () => {
  const source = [
    '# Your orders',
    '',
    'You have **two** orders, see [the list](https://shop.example/orders).',
    '* first: _pending_',
    '+ second: ~~cancelled~~ `A-2`',
    '',
    '*Order A-1* — paid, 10.00',
  ].join('\n');

  it('whatsapp: bold with one star, links spelled out, bullets as dashes', () => {
    expect(toChannelMarkdown(source, 'whatsapp')).toBe(
      [
        '*Your orders*',
        '',
        'You have *two* orders, see the list (https://shop.example/orders).',
        '- first: _pending_',
        '- second: ~cancelled~ `A-2`',
        '',
        // a component fallback's mrkdwn bold stays bold
        '*Order A-1* — paid, 10.00',
      ].join('\n'),
    );
  });

  it('telegram: MarkdownV2 with every reserved character escaped', () => {
    expect(toChannelMarkdown(source, 'telegram')).toBe(
      [
        '*Your orders*',
        '',
        'You have *two* orders, see [the list](https://shop.example/orders)\\.',
        '• first: _pending_',
        '• second: ~cancelled~ `A-2`',
        '',
        '*Order A\\-1* — paid, 10\\.00',
      ].join('\n'),
    );
  });

  it('none: the words only', () => {
    expect(toChannelMarkdown(source, 'none')).toBe(
      [
        'Your orders',
        '',
        'You have two orders, see the list (https://shop.example/orders).',
        '- first: pending',
        '- second: cancelled A-2',
        '',
        'Order A-1 — paid, 10.00',
      ].join('\n'),
    );
  });

  it('leaves code alone and does not read snake_case or arithmetic as formatting', () => {
    const text = 'Use `user_id` and 2*3*4 in my_var.\n```ts\nconst a_b = 1 * 2;\n```';
    expect(toChannelMarkdown(text, 'whatsapp')).toBe(
      'Use `user_id` and 2*3*4 in my_var.\n```const a_b = 1 * 2;```',
    );
    expect(toChannelMarkdown(text, 'telegram')).toBe(
      'Use `user_id` and 2\\*3\\*4 in my\\_var\\.\n```ts\nconst a_b = 1 * 2;```',
    );
  });

  it('telegram escaping round-trips', () => {
    const text = 'a_b *c* [d](e) 1.5! #tag (x) {y} |z| =w+v- ~t~ >q `r` \\';
    expect(unescapeTelegramMarkdown(escapeTelegramMarkdown(text))).toBe(text);
  });
});

describe('splitMessage', () => {
  it('returns short text as one message', () => {
    expect(splitMessage('  hello  ', 10)).toEqual(['hello']);
  });

  it('cuts at a paragraph break first', () => {
    const text = `${'a'.repeat(30)}\n\n${'b'.repeat(30)}`;
    expect(splitMessage(text, 40)).toEqual(['a'.repeat(30), 'b'.repeat(30)]);
  });

  it('cuts after a sentence when there is no break', () => {
    const text = 'One sentence here. Another sentence follows it. And a third one.';
    const pieces = splitMessage(text, 30);
    expect(pieces[0]).toBe('One sentence here.');
    expect(pieces.every((piece) => piece.length <= 30)).toBe(true);
    expect(pieces.join(' ')).toBe(text);
  });

  it('cuts at a space, and mid-word only when it must', () => {
    expect(splitMessage('alpha beta gamma', 11)).toEqual(['alpha beta', 'gamma']);
    expect(splitMessage('x'.repeat(25), 10)).toEqual([
      'x'.repeat(10),
      'x'.repeat(10),
      'x'.repeat(5),
    ]);
  });

  it('refuses a nonsensical limit', () => {
    expect(() => splitMessage('a', 0)).toThrow(RangeError);
  });
});

describe('questions', () => {
  const color: ElicitationQuestion = {
    id: 'color',
    prompt: 'Which color?',
    options: [
      { value: 'r', label: 'Red' },
      { value: 'g', label: 'Green' },
      { value: 'b', label: 'Blue' },
    ],
    defaults: ['g'],
  };

  it('formats a question with numbered options and its defaults', () => {
    expect(formatChannelQuestion(color, { index: 0, total: 2, preamble: 'A few things:' })).toBe(
      [
        'A few things:',
        '',
        '*(1/2) Which color?*',
        '',
        '1. Red',
        '2. Green',
        '3. Blue',
        '',
        'Reply with the number of your choice.',
        'Reply *skip* to keep: Green.',
      ].join('\n'),
    );
  });

  it('reads a number, a label, the skip word — and refuses anything else', () => {
    expect(parseChannelAnswer(color, '3')).toEqual({ status: 'answer', values: ['b'] });
    expect(parseChannelAnswer(color, ' red ')).toEqual({ status: 'answer', values: ['r'] });
    expect(parseChannelAnswer(color, '2.')).toEqual({ status: 'answer', values: ['g'] });
    expect(parseChannelAnswer(color, 'SKIP')).toEqual({ status: 'skip' });
    expect(parseChannelAnswer(color, '7')).toMatchObject({ status: 'invalid' });
    expect(parseChannelAnswer(color, 'purple')).toMatchObject({ status: 'invalid' });
    expect(parseChannelAnswer({ ...color, allowFreeText: true }, 'purple')).toEqual({
      status: 'answer',
      values: ['purple'],
    });
  });

  it('reads several picks for a multiple choice', () => {
    const many = { ...color, multiple: true };
    expect(parseChannelAnswer(many, '1, 3')).toEqual({ status: 'answer', values: ['r', 'b'] });
    expect(parseChannelAnswer(many, '1 3 3')).toEqual({ status: 'answer', values: ['r', 'b'] });
    expect(parseChannelAnswer(many, '1, 9')).toMatchObject({ status: 'invalid' });
  });

  it('takes a typed value, checked against its type', () => {
    const guests: ElicitationQuestion = {
      id: 'guests',
      prompt: 'How many guests?',
      input: { type: 'number', min: 1, max: 10 },
    };
    expect(formatChannelQuestion(guests, { index: 0, total: 1 })).toBe('*How many guests?*');
    expect(parseChannelAnswer(guests, '4')).toEqual({ status: 'answer', values: ['4'] });
    expect(parseChannelAnswer(guests, 'many')).toMatchObject({ status: 'invalid' });
    expect(parseChannelAnswer(guests, '40')).toMatchObject({ status: 'invalid' });
  });
});
