---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent': minor
'@dudousxd/nestjs-agent-react': minor
'@dudousxd/nestjs-agent-store-drizzle': minor
'@dudousxd/nestjs-agent-store-mikro-orm': minor
'@dudousxd/nestjs-agent-testing': minor
---

Elicitation typed inputs.

- core: `ElicitationQuestion` gains `description?` and `input?: { type: 'text' | 'textarea' | 'number' | 'boolean' | 'date' | 'email' | 'url' | 'select'; placeholder?; required?; min?; max?; pattern? }`. `options` is optional when `input` asks for a typed value, and a typed question may omit `defaults`. The `ask` tool accepts and describes them. Answers stay `string[]` in one canonical form per type. `validateElicitationValue` / `validateElicitationAnswer` / `readElicitationQuestions` are shared by the loop (which drops values it cannot settle), the server and the client. New optional store method `toolCallInput`.
- nestjs: `POST tool-call/answer` checks answers against the parked questions and answers `400 answers["<id>"] <reason>` for a value a question refuses, or for a required question left without an answer or default.
- stores: implement `toolCallInput`.
- react: transcript questions carry `description`, `input`, `value`, `setValue(raw)` and `error`, and the block carries `isValid`. Headless `coerceAnswer(question, raw)` and `validateAnswer` are exported.
