import type { UIMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import {
  type AnyToolUIPart,
  type ElicitationBlockOptions,
  type TranscriptElicitationBlock,
  type TranscriptToolBlock,
  buildTranscriptBlocks,
} from './model.js';

const base = {
  isReasoningOpen: (_key: string, isStreaming: boolean) => isStreaming,
  toggleReasoning: () => undefined,
};

const QUESTIONS = [
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
    prompt: 'Which tests should I touch?',
    multiple: true,
    options: [
      { value: 'unit', label: 'Unit' },
      { value: 'e2e', label: 'End to end' },
    ],
    defaults: ['unit'],
  },
];

function askPart(overrides: Partial<Record<string, unknown>> = {}): AnyToolUIPart {
  return {
    type: 'tool-ask',
    toolCallId: 'intake-run-1',
    state: 'input-available',
    input: { preamble: 'A few questions before I start.', questions: QUESTIONS },
    ...overrides,
  } as AnyToolUIPart;
}

function readTool(): AnyToolUIPart {
  return {
    type: 'tool-executeSql',
    toolCallId: 'sql-1',
    state: 'output-available',
    input: { query: 'SELECT 1' },
    output: { rows: [] },
  } as AnyToolUIPart;
}

function message(parts: UIMessage['parts']): UIMessage {
  return { id: 'm1', role: 'assistant', parts };
}

function elicitationOptions(
  overrides: Partial<ElicitationBlockOptions> = {},
): ElicitationBlockOptions {
  return {
    picked: () => undefined,
    pick: () => undefined,
    canAnswer: true,
    canSkip: true,
    answer: () => undefined,
    skip: () => undefined,
    isSubmitting: () => false,
    errorOf: () => null,
    ...overrides,
  };
}

function blocksOf(parts: UIMessage['parts'], options: Partial<ElicitationBlockOptions> = {}) {
  return buildTranscriptBlocks(message(parts), {
    ...base,
    elicitation: elicitationOptions(options),
  });
}

function only(parts: UIMessage['parts'], options: Partial<ElicitationBlockOptions> = {}) {
  const block = blocksOf(parts, options)[0];
  return block as TranscriptElicitationBlock;
}

describe('buildTranscriptBlocks — a parked question set', () => {
  it('leaves the question set in the tool run when the host cannot settle it', () => {
    const blocks = buildTranscriptBlocks(message([askPart()]), base);
    expect(blocks.map((block) => block.kind)).toEqual(['tools']);
  });

  it('lifts it into its own block, with the questions numbered against the whole set', () => {
    const block = only([askPart()]);

    expect(block.kind).toBe('elicitation');
    expect(block.toolCallId).toBe('intake-run-1');
    expect(block.preamble).toBe('A few questions before I start.');
    expect(block.questionCount).toBe(2);
    expect(block.questions.map((question) => question.position)).toEqual([1, 2]);
    expect(block.questions[0]?.prompt).toBe('How much should I cover?');
    expect(block.questions[0]?.multiple).toBe(false);
    expect(block.questions[1]?.multiple).toBe(true);
    expect(block.questions[0]?.options.map((option) => option.hotkey)).toEqual(['a', 'b']);
    expect(block.questions[1]?.options.map((option) => option.hotkey)).toEqual([null, null]);
  });

  it('pre-picks the defaults, and says the question is untouched', () => {
    const block = only([askPart()]);

    expect(block.questions[0]?.selected).toEqual(['module']);
    expect(block.questions[0]?.isPristine).toBe(true);
    const [file, module] = block.questions[0]?.options ?? [];
    expect(file).toMatchObject({ value: 'file', isSelected: false, isDefault: false });
    expect(module).toMatchObject({ value: 'module', isSelected: true, isDefault: true });
  });

  it('shows the host-held pick over the default once the user has touched the question', () => {
    const block = only([askPart()], { picked: () => ['file'] });

    expect(block.questions[0]?.selected).toEqual(['file']);
    expect(block.questions[0]?.isPristine).toBe(false);
    expect(block.questions[0]?.options[0]?.isSelected).toBe(true);
  });

  it('replaces the selection on a single-choice question and toggles it on a multiple one', () => {
    const pick = vi.fn();
    const picked = (_id: string, questionId: string) =>
      questionId === 'tests' ? ['unit'] : undefined;
    const block = only([askPart()], { pick, picked });

    block.questions[0]?.options[0]?.select();
    expect(pick).toHaveBeenLastCalledWith('intake-run-1', 'scope', ['file']);

    block.questions[1]?.options[1]?.select();
    expect(pick).toHaveBeenLastCalledWith('intake-run-1', 'tests', ['unit', 'e2e']);

    block.questions[1]?.options[0]?.select();
    // Deselecting the last pick is an explicit "none of these", not a fall back to the default.
    expect(pick).toHaveBeenLastCalledWith('intake-run-1', 'tests', []);
  });

  it('offers answer and skip while it is parked, and runs them by tool-call id', () => {
    const answer = vi.fn();
    const skip = vi.fn();
    const block = only([askPart()], { answer, skip });

    expect(block.isPending).toBe(true);
    expect(block.answer.available).toBe(true);
    expect(block.skip.available).toBe(true);
    block.answer.run();
    block.skip.run();
    expect(answer).toHaveBeenCalledWith('intake-run-1');
    expect(skip).toHaveBeenCalledWith('intake-run-1');
  });

  it('withdraws both actions once the run has settled it, and reads back the outcome', () => {
    const block = only([
      askPart({
        state: 'output-available',
        output: {
          answers: { scope: ['file'], tests: ['unit'] },
          skipped: false,
          defaulted: ['tests'],
          summary: 'The user answered:\nHow much should I cover? → This file',
        },
      }),
    ]);

    expect(block.isPending).toBe(false);
    expect(block.answer.available).toBe(false);
    expect(block.skip.available).toBe(false);
    expect(block.outcome).toEqual({
      answers: { scope: ['file'], tests: ['unit'] },
      skipped: false,
      defaulted: ['tests'],
      summary: 'The user answered:\nHow much should I cover? → This file',
    });
    // The settled answers are what the form shows, so one piece of markup renders both states.
    expect(block.questions[0]?.selected).toEqual(['file']);
    expect(block.questions[0]?.options[0]?.isSelected).toBe(true);
    // Which of them the human actually touched survives the settlement.
    expect(block.questions.map((question) => question.isPristine)).toEqual([false, true]);
  });

  it('surfaces a failed submission and keeps the form live', () => {
    const block = only([askPart()], { errorOf: () => 'Agent request failed: 403' });

    expect(block.error).toBe('Agent request failed: 403');
    expect(block.isPending).toBe(true);
    expect(block.answer.available).toBe(true);
  });

  it('reports the submission in flight until the run settles the part', () => {
    expect(only([askPart()], { isSubmitting: () => true }).answer.isSubmitting).toBe(true);
    expect(
      only([askPart({ state: 'output-available', output: { answers: {}, skipped: true } })], {
        isSubmitting: () => true,
      }).answer.isSubmitting,
    ).toBe(false);
  });

  it('withholds each action the host gave it nowhere to send', () => {
    const block = only([askPart()], { canAnswer: false });
    expect(block.answer.available).toBe(false);
    expect(block.skip.available).toBe(true);
  });

  it('ends the tool run it lands in the middle of, keeping the message order', () => {
    const blocks = blocksOf([readTool(), askPart(), readTool()]);
    expect(blocks.map((block) => block.kind)).toEqual(['tools', 'elicitation', 'tools']);
  });

  it('recognizes the set by its shape, not by the tool it was persisted under', () => {
    const renamed = askPart({ type: 'tool-clarify', toolCallId: 'call-9' });
    expect(only([renamed]).kind).toBe('elicitation');

    const lookalike = {
      type: 'tool-createSurvey',
      toolCallId: 'call-10',
      state: 'input-available',
      input: { questions: ['how are you?'] },
    } as AnyToolUIPart;
    expect(blocksOf([lookalike]).map((block) => block.kind)).toEqual(['tools']);
  });
});

describe('buildTranscriptBlocks — a tool call parked on approval', () => {
  function approvalBlock(parts: UIMessage['parts']): TranscriptToolBlock {
    return buildTranscriptBlocks(message(parts), {
      ...base,
      approval: {
        canApprove: true,
        canReject: true,
        approve: () => undefined,
        reject: () => undefined,
        isSubmitting: () => false,
        errorOf: () => null,
      },
    })[0] as TranscriptToolBlock;
  }

  function actionPart(state: string): AnyToolUIPart {
    return {
      type: 'tool-purgeCache',
      toolCallId: 'call-2',
      state,
      input: { key: 'all' },
      toolMetadata: { toolKind: 'action' },
    } as AnyToolUIPart;
  }

  it('names the calls in the run alongside the parts, so a renderer can key off either', () => {
    const block = approvalBlock([readTool(), actionPart('input-available')]);
    expect(block.parts).toHaveLength(2);
    expect(block.calls.map((call) => call.name)).toEqual(['executeSql', 'purgeCache']);
  });

  it('parks an action tool whose input landed but whose output never will on its own', () => {
    const block = approvalBlock([actionPart('input-available')]);
    const call = block.calls[0];
    expect(call?.isAwaitingApproval).toBe(true);
    expect(call?.approve.available).toBe(true);
    expect(call?.reject.available).toBe(true);
  });

  it('leaves a read tool and an already-settled action alone', () => {
    expect(approvalBlock([readTool()]).calls[0]?.isAwaitingApproval).toBe(false);
    expect(approvalBlock([actionPart('output-available')]).calls[0]?.isAwaitingApproval).toBe(
      false,
    );
    expect(approvalBlock([actionPart('output-denied')]).calls[0]?.isAwaitingApproval).toBe(false);
  });

  it('never offers approve/reject on a question set, which parks as an action but is answered', () => {
    // What the loop streams for the model's own `ask`: an action-classified call, parked, whose
    // input is a question set. Approving it would settle nothing.
    const ask = {
      type: 'tool-ask',
      toolCallId: 'call-3',
      state: 'input-available',
      input: { questions: QUESTIONS },
      toolMetadata: { toolKind: 'action' },
    } as AnyToolUIPart;

    const block = approvalBlock([ask]);

    expect(block.calls[0]?.isAwaitingApproval).toBe(false);
    expect(block.calls[0]?.approve.available).toBe(false);
  });

  it('offers no approval at all when the host wired none', () => {
    const block = buildTranscriptBlocks(
      message([actionPart('input-available')]),
      base,
    )[0] as TranscriptToolBlock;
    expect(block.calls[0]?.isAwaitingApproval).toBe(true);
    expect(block.calls[0]?.approve.available).toBe(false);
  });
});
