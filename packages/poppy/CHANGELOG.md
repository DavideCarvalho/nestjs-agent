# @dudousxd/nestjs-agent-poppy

## 0.1.1

### Patch Changes

- [#379](https://github.com/DavideCarvalho/nestjs-agent/pull/379) [`ac24f24`](https://github.com/DavideCarvalho/nestjs-agent/commit/ac24f24bb12e580318cdc442de3ace34bfe4608b) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A Poppy conversation started signed out now continues after the User signs in. The step-up turn used to fail with `thread belongs to another actor` (the thread belonged to the signed-out `poppy:<hash>` actor, the turn ran as the account) and the personal agent got "Sorry, something went wrong". When the thread's owner is not the turn's actor, the turn runs in a new thread, told the conversation's earlier messages as a transcript. `PersonalAgentTurnService` may implement `threadOwner` (`AgentService` does).

## 0.1.0

### Minor Changes

- [#377](https://github.com/DavideCarvalho/nestjs-agent/pull/377) [`25ccb40`](https://github.com/DavideCarvalho/nestjs-agent/commit/25ccb408fd03cd284036503b8443b7ea6b6694aa) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - New package (experimental — tracks Personal Agent Protocol "Poppy" Draft 0.1; it will change, possibly in breaking ways, outside semver majors while the spec is a draft):

  - **`AgentPoppyModule`** — the company-side conversation endpoint (§7): `POST {path}`, `/{id}/messages`, `GET /{id}/events` (cursor, `wait`, SSE with `Last-Event-ID` and `text-delta`), `/{id}/handoff`, `/{id}/close`; Direct Conversations; idempotent message ids (`message_id_conflict`); `authorization` events (`sign_in_required` / `insufficient_scope`) for tools behind a scope the token lacks; actions (blocking or independent proposals) approved by the token's scopes, returned as `data.actions` and always told in words (`formatAction`); a durable event log that is the turn queue, with a reader lease and recovery. Session Tokens are verified by the resolver in `Symbol.for('@adonis-agora/poppy:authenticate')` (the same contract as `@adonis-agora/authkit-server`) or `authenticate`; `501` without one. With `baseUrl`, the endpoint is announced in `Symbol.for('@adonis-agora/poppy:endpoints')`. `PoppyConversations` drives the company side (a person joining, handoff, `user_requested`).
  - **`AgentPoppyConnectionsModule`** — the app's agent acting at other Poppy companies for its users: identity routes (`agent.json`, `jwks.json`, `logo.svg`, `oauth/callback`), connect pages (Direct with PKCE + `iss`, Mediated, Device), connections sealed at rest (AES-256-GCM, `secret`), an allow-list of companies (default none), and the tools `poppy_companies`, `poppy_connect` (a link card valid as long as the link), `poppy_tools`, `poppy_read`, `poppy_ask` (narrowed to read scopes), `poppy_write` (two-step company tools committed on confirm), `poppy_request`, `poppy_disconnect`. A completed sign-in decides the parked connect call; under independent approvals the conversation continues with a new turn, delivered to the text channel it came from.
  - **`@dudousxd/nestjs-agent-poppy/client`** and the **`poppy-agent`** CLI — the reference Personal Agent, the same client (same API and conformance suite) as `@adonis-agora/agent/poppy-client`.
  - `runPersonalAgentTurn` — run a personal agent's turn over `AgentService`.
