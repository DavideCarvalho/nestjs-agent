import { describe, expect, it } from 'vitest';
import {
  type ElicitationRequest,
  MAX_ASK_QUESTIONS,
  askInputSchema,
  askToolDefinition,
  normalizeElicitationReply,
  resolveElicitation,
  settleElicitation,
} from './elicitation.js';

const request: ElicitationRequest = {
  id: 'e1',
  source: 'ask',
  questions: [
    {
      id: 'scope',
      prompt: 'How much should I cover?',
      options: [
        { value: 'file', label: 'This file', hotkey: 'a' },
        { value: 'module', label: 'The whole module', hotkey: 'b' },
      ],
      defaults: ['module'],
    },
    {
      id: 'tests',
      prompt: 'Which tests?',
      multiple: true,
      options: [
        { value: 'unit', label: 'Unit' },
        { value: 'e2e', label: 'End to end' },
      ],
      defaults: ['unit'],
    },
  ],
};

describe('resolveElicitation — what "just submit" means', () => {
  it('fills an unanswered question from its own defaults and says it did', () => {
    const outcome = resolveElicitation(request, { answers: {} });
    expect(outcome).toEqual({
      answers: { scope: ['module'], tests: ['unit'] },
      skipped: false,
      defaulted: ['scope', 'tests'],
    });
  });

  it('does not count an explicit answer as defaulted, even when it equals the default', () => {
    const outcome = resolveElicitation(request, { answers: { scope: ['module'] } });
    expect(outcome.answers.scope).toEqual(['module']);
    expect(outcome.defaulted).toEqual(['tests']);
  });

  it('treats a present-but-empty answer as "none of these", not as unanswered', () => {
    const outcome = resolveElicitation(request, { answers: { tests: [] } });
    expect(outcome.answers.tests).toEqual([]);
    expect(outcome.defaulted).toEqual(['scope']);
  });

  it('drops a value that was never on offer', () => {
    const outcome = resolveElicitation(request, { answers: { scope: ['everything'] } });
    expect(outcome.answers.scope).toEqual([]);
  });

  it('keeps an off-menu value for a question that invited one', () => {
    const freeText: ElicitationRequest = {
      ...request,
      questions: request.questions.map((question) => ({ ...question, allowFreeText: true })),
    };
    expect(
      resolveElicitation(freeText, { answers: { scope: ['just the imports'] } }).answers.scope,
    ).toEqual(['just the imports']);
  });

  it('collapses a single-choice question to one value', () => {
    expect(
      resolveElicitation(request, { answers: { scope: ['file', 'module'] } }).answers.scope,
    ).toEqual(['file']);
  });

  it('lands a skip on the same values as a confirmation, and still records it as a skip', () => {
    const confirmed = resolveElicitation(request, { answers: {} });
    const skipped = resolveElicitation(request, { answers: { scope: ['file'] }, skipped: true });
    expect(skipped.answers).toEqual(confirmed.answers);
    expect(skipped.skipped).toBe(true);
    expect(confirmed.skipped).toBe(false);
  });
});

describe('settleElicitation — what the model reads back', () => {
  it('renders the chosen options by label, not by their opaque values', () => {
    const result = settleElicitation(request, { answers: { scope: ['file'] } });
    expect(result.summary).toContain('How much should I cover? → This file');
    expect(result.summary).toContain('Which tests? → Unit');
    expect(result.summary).not.toContain('file,');
  });

  it('tells the model when the user declined rather than answered', () => {
    expect(settleElicitation(request, { answers: {}, skipped: true }).summary).toContain(
      'declined to answer',
    );
  });
});

describe('the ask tool contract', () => {
  const question = {
    id: 'scope',
    prompt: 'How much?',
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ],
    defaults: ['b'],
  };

  it('accepts a well-formed question set', async () => {
    const result = await askInputSchema['~standard'].validate({ questions: [question] });
    expect(result.issues).toBeUndefined();
  });

  it('refuses a question that pre-picks nothing — confirming has to be enough', async () => {
    const result = await askInputSchema['~standard'].validate({
      questions: [{ ...question, defaults: [] }],
    });
    expect(result.issues?.[0]?.message).toMatch(/pre-pick at least one option/);
  });

  it('refuses a default that is not one of the options it offers', async () => {
    const result = await askInputSchema['~standard'].validate({
      questions: [{ ...question, defaults: ['c'] }],
    });
    expect(result.issues?.[0]?.message).toMatch(/appear in this question/);
  });

  it('refuses more questions than a user will sit through', async () => {
    const result = await askInputSchema['~standard'].validate({
      questions: Array.from({ length: MAX_ASK_QUESTIONS + 1 }, (_, index) => ({
        ...question,
        id: `q${index}`,
      })),
    });
    expect(result.issues?.[0]?.message).toMatch(/at most/);
  });

  it('publishes a JSON schema a provider can constrain generation against', () => {
    const standard = askToolDefinition().inputSchema['~standard'] as {
      jsonSchema?: { input: () => { required?: string[] } };
    };
    expect(standard.jsonSchema?.input().required).toEqual(['questions']);
  });

  it('declares the ask kind, so the loop never routes it to a handler', () => {
    expect(askToolDefinition().kind).toBe('ask');
  });
});

describe('resolveElicitation — a reply that came back off the approvals inbox', () => {
  it('reads an Approve as "yes, every pre-picked answer"', () => {
    const outcome = resolveElicitation(request, { approved: true });
    expect(outcome).toEqual({
      answers: { scope: ['module'], tests: ['unit'] },
      skipped: false,
      defaulted: ['scope', 'tests'],
    });
  });

  it('reads a Reject as a skip, which is what declining to answer already means', () => {
    const outcome = resolveElicitation(request, { approved: false });
    expect(outcome.skipped).toBe(true);
    expect(outcome.answers).toEqual({ scope: ['module'], tests: ['unit'] });
  });

  it('carries the operator who decided through as the one who answered', () => {
    expect(
      normalizeElicitationReply({ approved: true, executedByRef: 'admin-7' }).answeredByRef,
    ).toBe('admin-7');
  });

  it('leaves a real answer set untouched', () => {
    const reply = { answers: { scope: ['file'] }, answeredByRef: 'u1' };
    expect(normalizeElicitationReply(reply)).toBe(reply);
  });
});
