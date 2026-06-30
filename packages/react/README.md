# `@dudousxd/nestjs-agent-react`

> 🪺 Part of the [Aviary](https://davidecarvalho.github.io/aviary) · the React frontend for [`@dudousxd/nestjs-agent`](https://www.npmjs.com/package/@dudousxd/nestjs-agent).

`useAgentChat` wraps the Vercel **AI SDK v6** `useChat` with a transport for the agent's `/agent/chat`
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
    getHeaders: () => ({ 'x-actor-id': me.id, 'x-actor-role': me.role }),
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

### Optional markdown subpath

```tsx
import { AgentMarkdown } from '@dudousxd/nestjs-agent-react/markdown';
// <MessageList renderText={(text, { isStreaming }) => <AgentMarkdown isStreaming={isStreaming}>{text}</AgentMarkdown>} />
```

`AgentMarkdown` ships the full streamdown stack (GFM, KaTeX, syntax-highlighted code, Mermaid) — those
renderers are **optional peer dependencies**, so the base package stays light for apps that don't need them.

## License

MIT © Davide Carvalho
