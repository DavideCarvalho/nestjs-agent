import type { StoredMessage } from '@dudousxd/nestjs-agent-core';
import type { UIMessage } from 'ai';

/**
 * Convert a persisted `StoredMessage` (the agent-lib's on-disk shape) into an AI SDK v7
 * `UIMessage` so a loaded thread can seed `useChat`'s `initialMessages` / `messages`.
 *
 * The lib stores a message as flat `content` text plus `toolCalls`/`toolResults` arrays; the SDK
 * renders from `parts`. This maps:
 *   - `content`            → a single `text` part (skipped when empty).
 *   - each `attachment`    → a `file` part (image/PDF) so the user bubble re-renders its
 *                            thumbnails on a reloaded thread.
 *   - each `toolCall`      → a `tool-<name>` part, pairing its `toolResult` (matched by id):
 *       - a result found   → `output-available` state, carrying `output`.
 *       - no result found  → `input-available` state (the call never finished, e.g. the run was
 *                            interrupted) — `output` is omitted, never a fabricated value.
 *     When the store reports the tool's kind (`'read' | 'action'`), it rides along as
 *     `toolMetadata.toolKind` so a UI can render an approval affordance for `action` tools
 *     without hardcoding tool-name sets, matching how live-streamed tool parts carry it.
 *
 * Live streaming still arrives as fully-typed SDK tool parts (see `AgentChatTransport`); this
 * converter only feeds replayed history, so the tool cards render the same either way.
 */
export function storedMessageToUiMessage(message: StoredMessage): UIMessage {
  const parts: UIMessage['parts'] = [];

  if (message.content) {
    parts.push({ type: 'text', text: message.content });
  }

  for (const attachment of message.attachments ?? []) {
    parts.push({
      type: 'file',
      mediaType: attachment.contentType,
      filename: attachment.name,
      url: attachment.url,
    });
  }

  for (const call of message.toolCalls ?? []) {
    const result = message.toolResults?.find((candidate) => candidate.id === call.id);
    // `call.kind` — the store's `'read' | 'action'` classification, once it lands there
    // (parallel to `RecordToolCallInput.toolType` and the stream's `toolKind`).
    const toolKind = call.kind;
    parts.push({
      type: `tool-${call.name}`,
      toolCallId: call.id,
      ...(toolKind !== undefined ? { toolMetadata: { toolKind } } : {}),
      ...(result !== undefined
        ? { state: 'output-available', input: call.input, output: result.output }
        : { state: 'input-available', input: call.input }),
    });
  }

  return { id: message.id, role: message.role, parts };
}
