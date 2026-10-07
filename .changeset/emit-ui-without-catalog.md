---
"@dudousxd/nestjs-agent-core": patch
---

`ctx.emitUi` no longer throws when the client sends `uiCapabilities` and the server has no genui catalog. That throw used to fail the tool body itself. With no catalog to negotiate against, a component the client declared (at that version) is drawn. Any other component becomes its `fallbackText`, or shows nothing if it has none.
