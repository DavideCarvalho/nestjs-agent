---
'@dudousxd/nestjs-agent-core': minor
---

New entry point `@dudousxd/nestjs-agent-core/guardrails`: PII (Luhn-validated cards, CPF/CNPJ, SSN, IBAN, phones, emails, IPv4), secret (provider key formats, JWT, PEM, entropy-gated assignments), prompt-injection (EN / PT-BR / ES, hidden Unicode, encoded payloads) and tool-poisoning detectors; a rule engine with `allow`/`log`/`redact`/`approve`/`block`, fail modes and reversible redaction (`Vault`); `StreamGuard` for OpenAI / Anthropic SSE streams; and `createGuardrails(options)`, which puts it all on the loop's processor seams — `guardrails.input` / `guardrails.output`, `wrapTool` for tool arguments, `screenTool` for tool definitions — with per-call rule resolution and an audit hook. The entry point imports nothing, so it works without NestJS and without the agent loop.
