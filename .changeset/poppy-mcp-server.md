---
"@dudousxd/nestjs-agent-mcp-server": minor
---

Personal agents (Poppy, experimental Draft 0.1): the server's policy is wrapped in `personalAgentGate`, and a `tools/call` to an offered tool whose scope the personal agent was not granted is refused before it runs with `403` and `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"`. `poppyActorResolver` verifies a Poppy session's token with the resolver in `Symbol.for('@adonis-agora/poppy:authenticate')` (or `authenticate`) and answers a signed-out session with `403 sign_in_required`; `asPersonalAgent(actor, scopes)` for apps that verify tokens themselves. Every 401/403 carries a `WWW-Authenticate` challenge (`McpChallengeException` / `McpChallengeFilter`); the 401 body is now `{ statusCode, error, message }`. New `oauth` / `baseUrl` options serve RFC 9728 protected-resource metadata, whose `authorization_servers` include the Poppy issuer announced in `Symbol.for('@adonis-agora/poppy:issuer')`.
