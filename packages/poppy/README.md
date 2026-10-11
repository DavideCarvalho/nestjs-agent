# @dudousxd/nestjs-agent-poppy

> **Experimental — tracks a draft spec.** Implements the
> [Personal Agent Protocol ("Poppy")](https://personalagentprotocol.org/docs/spec) **Draft 0.1**. The
> spec is still in development; this package **will change, possibly in breaking ways and outside
> semver majors**, as it evolves.

Poppy for [`@dudousxd/nestjs-agent`](../nestjs):

- **`AgentPoppyModule`** — be the Company Agent of personal agents' conversations (§7): create,
  messages, events (cursor, `wait`, SSE with `Last-Event-ID` and `text-delta`), handoff, close,
  Direct Conversations, idempotent message ids, `authorization` events, actions approved by the
  token's scopes and always told in words. Session Tokens are verified by the resolver an
  authorization server installs in `Symbol.for('@adonis-agora/poppy:authenticate')`, or your own.
- **`AgentPoppyConnectionsModule`** — your agent acting at **other** Poppy companies for its users:
  agent identity (`agent.json`, JWKS), per-user connections sealed at rest, connect links (Direct,
  Mediated, Device) that resume the conversation, and `poppy_*` tools behind your confirmation.
  Companies are allow-listed (default: none).
- **`@dudousxd/nestjs-agent-poppy/client`** + the **`poppy-agent`** CLI — a reference Personal Agent
  (the same client as `@adonis-agora/agent/poppy-client`).

Persistence comes from the store modules (`DrizzleAgentStoreModule`, `MikroOrmAgentStoreModule`
bind `AGENT_POPPY_STORE` / `AGENT_POPPY_CONNECTION_STORE`) or `RedisPoppyStore` /
`RedisPoppyConnectionStore` from `@dudousxd/nestjs-agent-transport-redis`; in memory otherwise.

```bash
pnpm add @dudousxd/nestjs-agent-poppy
```

```ts
@Module({
  imports: [
    AgentModule.forRoot({ /* … */ }),
    AgentPoppyModule.forRoot({ baseUrl: 'https://api.acme.com', agent: 'support' }),
  ],
})
export class AppModule {}
```

Docs: [Personal agents (Poppy)](https://davidecarvalho.github.io/aviary/docs/agent/guides/poppy),
[Poppy connections](https://davidecarvalho.github.io/aviary/docs/agent/guides/poppy-connections),
[the package and its client](https://davidecarvalho.github.io/aviary/docs/agent/packages/poppy).
