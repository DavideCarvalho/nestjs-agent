---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent': minor
---

`SkillProvider` takes named parameters.

`load(name, scope, ctx)` put two adjacent `string` arguments in a published signature. Transposed,
that call compiles without a complaint, returns `null`, and the skill silently fails to load — the
failure category this release has spent its time removing. `list(scopes, ctx)` follows for
consistency and because an object parameter can gain a field later without a breaking change.

```ts
list({ scopes, ctx })          // was: list(scopes, ctx)
load({ name, scope, ctx })     // was: load(name, scope, ctx)
```

`ListSkillsInput` and `LoadSkillInput` are exported. A single-argument method keeps its positional
form — `body(ctx)` is unchanged, because wrapping one well-named argument buys no safety.
