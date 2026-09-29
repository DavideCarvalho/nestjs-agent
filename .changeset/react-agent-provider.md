---
"@dudousxd/nestjs-agent-react": minor
---

`<AgentProvider>`: configure the agent connection once, and every hook uses it.

- **New** `<AgentProvider baseUrl path headers getHeaders credentials fetch attachments={{ upload }} genui={{ registry, catalog, … }}>` (or `backend={yourBackend}`) and `useAgentBackend()`. `useAgentChat`, `useThreads`, `useModels`, `useAgents`, `useQuota`, `useToolCatalog`, `useMessageFeedback` and `useAttachments` all take `backend` optionally and fall back to the provider — and, with no provider, to one shared same-origin client on `/agent`. `useAgentChat()` is callable with no argument. `genui` sets up `<GenuiProvider>` in the same element (`GenuiProvider` stays as the standalone building block).
- **New** `AgentClientOptions.path` (and `AgentChatTransportOptions.path`): the agent's route prefix, default `'agent'` — `baseUrl` is now just the origin. `AgentConnection` (handed to upload strategies) carries `path`.

**Breaking**

- `useAgentChat` no longer takes `baseUrl`, `headers`, `getHeaders`, `credentials`, `fetch`, `attachments` or `client` — put the connection on `<AgentProvider>` (or pass `backend: new AgentClient({ … })`). `chat.client` is gone; use `chat.backend`.
- `AgentClientOptions.attachments` is now `{ upload }` (was the strategy itself): `new AgentClient({ attachments: { upload: mediaAttachments() } })`.
- `useToolCatalog({ client })` → `useToolCatalog({ backend })` (optional); `createSkillsSource({ client })` → `createSkillsSource({ backend })`.
- `/media`: `withMediaUploads` is removed (use `<AgentProvider attachments={{ upload: mediaAttachments() }}>`, or `createMediaUpload(connection)` as your backend's `uploadAttachment`); `mediaAttachments({ path })` is removed — the path comes from the client's `path`.
- A `baseUrl` that included the agent prefix (`baseUrl: '/agent'`, which produced `/agent/agent/...`) must drop it: `baseUrl` is the origin, `path` the prefix.
