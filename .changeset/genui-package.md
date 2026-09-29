---
'@dudousxd/nestjs-agent-genui': minor
---

New package: a headless, isomorphic generative-UI catalog. `defineComponent` / `defineCatalog` with
Standard Schema or JSON Schema props (a built-in validator, or `ajvValidator(ajv)`),
`catalogToModelText`, `componentToText` plain-text fallbacks, tree validation and
`treeToFlatSpec`, and `genuiTools(catalog, { mode: 'per-component' | 'tree', terminal })`, which
builds lib tools that validate against the catalog and push `ui` frames through `ctx.emitUi`.
Optional builtin definitions (no visuals) under `/builtins`.
