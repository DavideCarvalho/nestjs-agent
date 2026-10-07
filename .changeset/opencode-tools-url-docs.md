---
"@dudousxd/nestjs-agent-opencode": patch
---

Docs: explain what `tools.url` must point at — it is passed verbatim to OpenCode and called back by the OpenCode server, so it is an address of the app as seen from there (same machine / Compose / Kubernetes / public URL), must reach a process that mounts controllers, and every process behind it needs the same `tools.secret`.
