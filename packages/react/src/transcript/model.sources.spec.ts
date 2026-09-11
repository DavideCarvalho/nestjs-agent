import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  type AnyToolUIPart,
  type RetrievedPassage,
  type TranscriptSourcesBlock,
  buildTranscriptBlocks,
} from './model.js';

const base = {
  isReasoningOpen: (_key: string, isStreaming: boolean) => isStreaming,
  toggleReasoning: () => undefined,
};
const withSources = { ...base, sources: true };

function retrieval(
  id: string,
  passages: Array<Partial<RetrievedPassage> & { id: string; text: string }>,
  toolName = 'retrieve',
  query: string | null = 'what shipped since Monday',
): AnyToolUIPart {
  return {
    type: `tool-${toolName}`,
    toolCallId: id,
    state: 'output-available',
    input: query === null ? {} : { query },
    output: { passages },
  } as AnyToolUIPart;
}

function message(parts: UIMessage['parts']): UIMessage {
  return { id: 'm1', role: 'assistant', parts };
}

function sourcesOf(blocks: ReturnType<typeof buildTranscriptBlocks>): TranscriptSourcesBlock[] {
  return blocks.filter((block): block is TranscriptSourcesBlock => block.kind === 'sources');
}

describe('buildTranscriptBlocks sources', () => {
  it('leaves retrieval in the tool run unless the host asks for sources', () => {
    const blocks = buildTranscriptBlocks(
      message([retrieval('r1', [{ id: 'p1', text: 'a', source: '#release' }])]),
      base,
    );
    expect(blocks.map((block) => block.kind)).toEqual(['tools']);
  });

  it('lifts a retrieval tool part into a sources block', () => {
    const blocks = buildTranscriptBlocks(
      message([
        retrieval('r1', [{ id: 'p1', text: 'a', source: '#release', score: 0.4 }]),
        { type: 'text', text: 'two blockers cleared' },
      ]),
      withSources,
    );
    expect(blocks.map((block) => block.kind)).toEqual(['sources', 'text']);
    expect(sourcesOf(blocks)[0]?.query).toBe('what shipped since Monday');
  });

  it('folds the passages of one origin into a single source', () => {
    const blocks = buildTranscriptBlocks(
      message([
        retrieval('r1', [
          { id: 'p1', text: 'a', source: '#release', score: 0.4 },
          { id: 'p2', text: 'b', source: '#release', score: 0.9 },
          { id: 'p3', text: 'c', source: 'ship calendar', score: 0.2 },
        ]),
      ]),
      withSources,
    );
    const block = sourcesOf(blocks)[0];
    expect(block?.passageCount).toBe(3);
    expect(block?.sources.map((source) => source.label)).toEqual(['#release', 'ship calendar']);
    expect(block?.sources[0]?.passageCount).toBe(2);
    expect(block?.sources[0]?.topScore).toBe(0.9);
  });

  it('detects retrieval by output shape, not by tool name', () => {
    const blocks = buildTranscriptBlocks(
      message([retrieval('r1', [{ id: 'p1', text: 'a' }], 'ask_the_wiki')]),
      withSources,
    );
    expect(blocks.map((block) => block.kind)).toEqual(['sources']);
  });

  it('labels a passage that carries no source with its own id', () => {
    const blocks = buildTranscriptBlocks(
      message([retrieval('r1', [{ id: 'chunk-7', text: 'a' }])]),
      withSources,
    );
    expect(sourcesOf(blocks)[0]?.sources[0]?.label).toBe('chunk-7');
  });

  it('keeps an ordinary tool call out of the provenance block', () => {
    const other = {
      type: 'tool-send_email',
      toolCallId: 't1',
      state: 'output-available',
      input: {},
      output: { ok: true },
    } as AnyToolUIPart;
    const blocks = buildTranscriptBlocks(
      message([retrieval('r1', [{ id: 'p1', text: 'a' }]), other]),
      withSources,
    );
    expect(blocks.map((block) => block.kind)).toEqual(['sources', 'tools']);
  });

  it('leaves a retrieval that found nothing as a tool call', () => {
    const blocks = buildTranscriptBlocks(message([retrieval('r1', [])]), withSources);
    expect(blocks.map((block) => block.kind)).toEqual(['tools']);
  });

  it('merges consecutive retrievals into one block and keeps the first query', () => {
    const blocks = buildTranscriptBlocks(
      message([
        retrieval('r1', [{ id: 'p1', text: 'a', source: '#release' }], 'retrieve', 'first'),
        retrieval('r2', [{ id: 'p2', text: 'b', source: 'calendar' }], 'retrieve', 'second'),
      ]),
      withSources,
    );
    const block = sourcesOf(blocks)[0];
    expect(blocks).toHaveLength(1);
    expect(block?.query).toBe('first');
    expect(block?.sources).toHaveLength(2);
  });
});
