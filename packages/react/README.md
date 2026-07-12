# `@dudousxd/nestjs-agent-react`

> 🪺 Part of the [Aviary](https://davidecarvalho.github.io/aviary) · the React frontend for [`@dudousxd/nestjs-agent`](https://www.npmjs.com/package/@dudousxd/nestjs-agent).

`useAgentChat` wraps the Vercel **AI SDK v7** `useChat` with a transport for the agent's `/agent/chat`
SSE, plus threads, personas, quota, cancel, and human-in-the-loop approve/reject. Ships styling-agnostic
chat components (every action is a callback; all styling via `classNames`) and an optional rich-markdown
subpath.

## Install

```bash
pnpm add @dudousxd/nestjs-agent-react @ai-sdk/react ai react
```

## Use

```tsx
import { useAgentChat, MessageList, ChatInput } from '@dudousxd/nestjs-agent-react';

function Chat() {
  const chat = useAgentChat({
    baseUrl: '/agent',
    getHeaders: () => ({ 'x-actor-id': me.id, 'x-actor-role': me.roles.join(',') }),
  });
  return (
    <>
      <MessageList
        messages={chat.messages}
        status={chat.status}
        regeneratable
        onRegenerate={() => chat.regenerate()}
      />
      <ChatInput onSubmit={(text) => chat.sendMessage({ text })} />
    </>
  );
}
```

## Bring your own UI

The package is **headless by design**. `useAgentChat` (state/streaming/persistence) and `AgentClient`
(the REST calls) own all the logic; `MessageList`/`ChatInput` — and the `markdown` subpath — are an
OPTIONAL, styling-agnostic reference implementation on top. A host with its own design system renders
straight off the hook's return value and never imports `MessageList` at all.

### `useAgentChat` on its own

```tsx
import { useAgentChat } from '@dudousxd/nestjs-agent-react';
import { isTextUIPart, isToolUIPart } from 'ai';

function CustomChat({ threadId }: { threadId?: string }) {
  const chat = useAgentChat({
    baseUrl: '/agent',
    // Omit the key entirely when absent — `UseAgentChatOptions` is built with
    // `exactOptionalPropertyTypes`, so an explicit `threadId: undefined` doesn't type-check.
    ...(threadId !== undefined ? { threadId } : {}),
    agent: 'support',
    // Reattach to a turn still streaming when the page loaded — survives a refresh.
    resume: true,
    getHeaders: () => ({ 'x-actor-id': currentUser.id }),
    onThreadCreated: (newThreadId) => router.replace(`/chat/${newThreadId}`),
    // Fires once per run when the SERVER is done writing (title + terminal state persisted) —
    // the right signal to refetch a thread list/sidebar; `onFinish` only means "a turn rendered".
    onRunSettled: ({ status }) => {
      if (status === 'completed') refetchThreadList();
    },
  });

  return (
    <div className="my-chat-shell">
      {chat.messages.map((message) => (
        <div
          key={message.id}
          className={message.role === 'user' ? 'my-bubble-user' : 'my-bubble-assistant'}
        >
          {message.parts.map((part, i) => {
            if (isTextUIPart(part)) return <p key={i}>{part.text}</p>;
            if (isToolUIPart(part)) return <MyToolCard key={i} part={part} />;
            return null;
          })}
        </div>
      ))}
      <MyComposer
        disabled={chat.status === 'streaming'}
        onSubmit={(text) => chat.sendMessage({ text })}
      />
    </div>
  );
}
```

`chat` is the AI SDK v7 `useChat` return value (`messages`, `status`, `sendMessage`, `stop`, …) spread
together with the extras: `runId`/`activeRunId`, `client` (the raw `AgentClient`), thread list/CRUD
(`threads`, `loadThreads`, `loadThread`, `deleteThread`, `forkThread`, `renameThread`, `promoteThread`,
`truncateFromMessage`), `quota`/`loadQuota`, `cancel`, HITL `approve`/`reject`, and `regenerate`.
`MyToolCard`'s `part` prop above types as the exported `AnyToolUIPart` (`ToolUIPart | DynamicToolUIPart`
— `MessageItem` uses the same union for its own `renderToolPart` callback).

### The transport, standalone

`AgentChatTransport` is a plain AI SDK v7 `ChatTransport` — wire it straight into `useChat` for the SSE
plumbing alone, with none of `useAgentChat`'s thread/quota/approval state:

```ts
import { useChat } from '@ai-sdk/react';
import { AgentChatTransport } from '@dudousxd/nestjs-agent-react';

const transport = new AgentChatTransport({
  baseUrl: '/agent',
  getHeaders: () => ({ 'x-actor-id': currentUser.id }),
  onMeta: ({ runId, threadId }) => console.log('turn started', runId, threadId),
});
const chat = useChat({ transport });
```

### Loading persisted history

A reloaded thread's `StoredMessage[]` (from `AgentClient.getThread`) needs converting to `UIMessage[]`
before it can seed `useChat`'s `initialMessages`:

```ts
import { storedThreadToUiMessages } from '@dudousxd/nestjs-agent-react';

const detail = await chat.client.getThread(threadId);
const initialMessages = storedThreadToUiMessages(detail.messages);
// Feed into useAgentChat({ threadId, initialMessages, ... }) on the mount that owns this thread —
// `initialMessages` is only read once, on mount.
```

`storedThreadToUiMessages` merges the store's one-row-per-model-iteration turns (a turn with tool
calls persists as "thinking…" + tool calls, then a separate final-answer row) into ONE `UIMessage` per
conversational turn, matching how the live stream renders — and stamps `metadata.usage` on any turn it
merged. For a single already-atomic row, `storedMessageToUiMessage` maps it 1:1 with no merging.

### Attachments and the raw client

`uploadAttachment` and the rest of `AgentClient` work outside `useAgentChat` too — e.g. from a
file-picker or a standalone approvals-inbox screen:

```ts
const attachment = await chat.client.uploadAttachment(file); // → MessageAttachment
await chat.sendMessage({ text: 'what is in this?' }, { body: { attachments: [attachment] } });

// Human-in-the-loop, callable from any component — not just the chat screen that raised it:
await chat.approve({ toolCallId });
await chat.reject({ toolCallId, reason: 'not now' });
```

### What a flip-style host owns

Everything visual: bubble layout and markdown rendering, the tool-card UI (branch on
`isToolUIPart`/`isDynamicToolUIPart`), composer design, and theming/design tokens — including how
"pending approval" reads in your product. The package never renders a pixel unless you opt into
`MessageList`/`ChatInput`; what it owns is the protocol: SSE parsing, resume/reconnect, thread CRUD,
quota, and HITL routing.

### Optional markdown subpath

```tsx
import { AgentMarkdown } from '@dudousxd/nestjs-agent-react/markdown';
// <MessageList renderText={(text, { isStreaming }) => <AgentMarkdown isStreaming={isStreaming}>{text}</AgentMarkdown>} />
```

`AgentMarkdown` ships the full streamdown stack (GFM, KaTeX, syntax-highlighted code, Mermaid) — those
renderers are **optional peer dependencies**, so the base package stays light for apps that don't need them.

## License

MIT © Davide Carvalho
