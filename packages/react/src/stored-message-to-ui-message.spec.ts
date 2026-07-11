import type { StoredMessage } from '@dudousxd/nestjs-agent-core';
import { describe, expect, it } from 'vitest';
import { storedMessageToUiMessage } from './stored-message-to-ui-message.js';

function message(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: 'msg-1',
    role: 'assistant',
    content: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('storedMessageToUiMessage', () => {
  it('maps a text-only message to a single text part', () => {
    const ui = storedMessageToUiMessage(message({ content: 'Hello there' }));

    expect(ui).toEqual({
      id: 'msg-1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Hello there' }],
    });
  });

  it('skips the text part when content is empty', () => {
    const ui = storedMessageToUiMessage(message({ content: '' }));
    expect(ui.parts).toEqual([]);
  });

  it('maps attachments to file parts, alongside the text part', () => {
    const ui = storedMessageToUiMessage(
      message({
        role: 'user',
        content: 'check this out',
        attachments: [
          { mediaId: 'm1', url: 'https://cdn/a.png', contentType: 'image/png', name: 'a.png' },
          {
            mediaId: 'm2',
            url: 'https://cdn/b.pdf',
            contentType: 'application/pdf',
            name: 'b.pdf',
          },
        ],
      }),
    );

    expect(ui.parts).toEqual([
      { type: 'text', text: 'check this out' },
      { type: 'file', mediaType: 'image/png', filename: 'a.png', url: 'https://cdn/a.png' },
      { type: 'file', mediaType: 'application/pdf', filename: 'b.pdf', url: 'https://cdn/b.pdf' },
    ]);
  });

  it('pairs multiple tool calls with their results by id, in output-available state', () => {
    const ui = storedMessageToUiMessage(
      message({
        content: '',
        toolCalls: [
          { id: 't1', name: 'listUsers', input: { limit: 5 } },
          { id: 't2', name: 'executeSql', input: { query: 'SELECT 1' } },
        ],
        toolResults: [
          { id: 't2', name: 'executeSql', output: { rows: [] } },
          { id: 't1', name: 'listUsers', output: { users: [] } },
        ],
      }),
    );

    expect(ui.parts).toEqual([
      {
        type: 'tool-listUsers',
        toolCallId: 't1',
        state: 'output-available',
        input: { limit: 5 },
        output: { users: [] },
      },
      {
        type: 'tool-executeSql',
        toolCallId: 't2',
        state: 'output-available',
        input: { query: 'SELECT 1' },
        output: { rows: [] },
      },
    ]);
  });

  it('renders a tool call with no matching result as input-available, without a fabricated output', () => {
    const ui = storedMessageToUiMessage(
      message({
        content: '',
        toolCalls: [{ id: 't1', name: 'longRunningJob', input: { jobId: 'j1' } }],
        toolResults: [],
      }),
    );

    expect(ui.parts).toEqual([
      {
        type: 'tool-longRunningJob',
        toolCallId: 't1',
        state: 'input-available',
        input: { jobId: 'j1' },
      },
    ]);
    const toolPart = ui.parts[0] as Record<string, unknown>;
    expect('output' in toolPart).toBe(false);
  });

  it('carries toolKind through as toolMetadata when the store reports it', () => {
    const ui = storedMessageToUiMessage(
      message({
        content: '',
        toolCalls: [
          { id: 't1', name: 'purgeCache', input: {}, kind: 'action' },
          { id: 't2', name: 'listUsers', input: {}, kind: 'read' },
        ],
        toolResults: [
          { id: 't1', name: 'purgeCache', output: { ok: true } },
          { id: 't2', name: 'listUsers', output: { users: [] } },
        ],
      }),
    );

    expect(ui.parts).toEqual([
      {
        type: 'tool-purgeCache',
        toolCallId: 't1',
        state: 'output-available',
        input: {},
        output: { ok: true },
        toolMetadata: { toolKind: 'action' },
      },
      {
        type: 'tool-listUsers',
        toolCallId: 't2',
        state: 'output-available',
        input: {},
        output: { users: [] },
        toolMetadata: { toolKind: 'read' },
      },
    ]);
  });

  it('omits toolMetadata when the store does not report a kind (older backends)', () => {
    const ui = storedMessageToUiMessage(
      message({
        content: '',
        toolCalls: [{ id: 't1', name: 'listUsers', input: {} }],
        toolResults: [{ id: 't1', name: 'listUsers', output: {} }],
      }),
    );

    const toolPart = ui.parts[0] as Record<string, unknown>;
    expect('toolMetadata' in toolPart).toBe(false);
  });
});
