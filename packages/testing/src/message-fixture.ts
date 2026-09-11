import type { AppendMessageInput } from '@dudousxd/nestjs-agent-core';

/**
 * Every optional field `appendMessage` accepts, all populated.
 *
 * Typed `Required<Omit<…>>` so a new optional field on `AppendMessageInput` fails to COMPILE here
 * until it is filled in — which is what then forces every spec using this fixture to prove the field
 * survives whatever it does. Three fields have been found silently dropped by an adapter this way
 * (`attachments`, `persona` in the sibling Adonis port, and `runId`), each invisible until a round
 * trip asserted on the whole shape rather than on the fields someone remembered.
 *
 * Exported from the testing package on purpose: a consumer writing its own `AgentStore` adapter
 * should be able to hold it to the same contract.
 */
export type EveryMessageField = Required<Omit<AppendMessageInput, 'threadId' | 'role' | 'content'>>;

export const EVERY_MESSAGE_FIELD: EveryMessageField = {
  agentName: 'analyst',
  runId: 'run-1',
  toolCalls: [{ id: 'call-1', name: 'executeSql', input: { query: 'select 1' }, kind: 'read' }],
  toolResults: [{ id: 'call-1', name: 'executeSql', output: { rows: 1 } }],
  attachments: [
    {
      mediaId: 'media-1',
      url: 'https://example.test/invoice.pdf',
      contentType: 'application/pdf',
      name: 'invoice.pdf',
    },
  ],
  followUps: ['what changed last month?'],
  usage: { inputTokens: 12, outputTokens: 34 },
};
