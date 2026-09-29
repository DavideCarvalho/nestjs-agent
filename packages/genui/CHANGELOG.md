# @dudousxd/nestjs-agent-genui

## 0.1.0

### Minor Changes

- [#205](https://github.com/DavideCarvalho/nestjs-agent/pull/205) [`a203035`](https://github.com/DavideCarvalho/nestjs-agent/commit/a2030354cc247a68cf3f0f73e8caf3fa714f87ca) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - New package: a headless, isomorphic generative-UI catalog. `defineComponent` / `defineCatalog` with
  Standard Schema or JSON Schema props (a built-in validator, or `ajvValidator(ajv)`),
  `catalogToModelText`, `componentToText` plain-text fallbacks, tree validation and
  `treeToFlatSpec`, and `genuiTools(catalog, { mode: 'per-component' | 'tree', terminal })`, which
  builds lib tools that validate against the catalog and push `ui` frames through `ctx.emitUi`.
  Optional builtin definitions (no visuals) under `/builtins`.
