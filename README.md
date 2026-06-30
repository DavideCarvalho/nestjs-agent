# `@dudousxd/nestjs-agent`

> 🪺 Part of the [Aviary](https://davidecarvalho.github.io/aviary) — plug-n-play, fully-configurable NestJS libraries.

A **governed, durable-backed AI agent** for NestJS — the Laravel feel for building an
in-app AI assistant. Chat + tool-calling + role/persona governance + token quota + cost
tracking + human-in-the-loop approval + resumable streaming, all out of the box. The
agent turn runs as a **durable workflow** (replay-safe, resumable, HITL via signals), and
plugs into the rest of the Aviary (durable, telescope, diagnostics, context, codegen).

Extracted from the flip-nestjs admin assistant. The **mechanism** is the library; your
**domain** (which tables, which tenant column, which roles) is policy you supply.

## Packages

| Package | What it is |
|---|---|
| `@dudousxd/nestjs-agent-core` | Framework-agnostic SPIs, tool registry, agent loop, personas, diagnostics |
| `@dudousxd/nestjs-agent` | The NestJS module: `@AiTool`, discovery, `/agent/*` controllers, durable + inline runners |
| `@dudousxd/nestjs-agent-store-mikro-orm` | MikroORM persistence (threads, messages, tool calls, usage, pricing) |
| `@dudousxd/nestjs-agent-transport-redis` | Resumable Redis token stream + cross-pod cancel |
| `@dudousxd/nestjs-agent-data` | Governed read-only SQL tool (AST-validated, RBAC + tenant scoping) |
| `@dudousxd/nestjs-agent-react` | `<AgentChat/>` + `useAgentChat` (Vercel AI SDK) |
| `@dudousxd/nestjs-agent-telescope` | "Agent" dashboard tab |
| `@dudousxd/nestjs-agent-diagnostics` | `aviary:agent:*` event channels |
| `@dudousxd/nestjs-agent-testing` | In-memory store/sink + deterministic fake model |

## Status

Early development. See `examples/agent-demo` for a runnable end-to-end proof
(durable agent run + SSE streaming + HITL approval + telescope), and
`docs/superpowers/specs/2026-06-30-nestjs-agent-design.md` for the design.

## License

MIT © Davide Carvalho
