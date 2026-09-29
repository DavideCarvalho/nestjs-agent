# @dudousxd/nestjs-agent-genui

## 0.2.0

### Minor Changes

- [#209](https://github.com/DavideCarvalho/nestjs-agent/pull/209) [`6149a46`](https://github.com/DavideCarvalho/nestjs-agent/commit/6149a469c466a50f5fa70da3b8d267c886103061) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `@dudousxd/nestjs-agent-react/genui`: headless rendering of server-pushed components. `<GenerativeUI
part registry catalog? resolveComponent? fallback? loading? onError?>` and `useGenerativeUI(part,
options)` resolve `component` (+ `version`) through the app's registry, then an optional async
  `resolveComponent(name, version)` for tenant components (cached), validate props against a genui
  catalog when given (synchronously when possible), isolate each item in its own error boundary and
  hand unknown components, invalid props and renderer errors to the app's fallback. `genui:tree`
  frames render node by node through the same registry. An optional json-render adapter
  (`/genui/json-render`, optional peer `@json-render/react` >= 0.21) renders trees through json-render.
  No styles.

  genui: `catalog.validateSync(name, props)` and `validatePropsSync` — the verdict without waiting
  when the schema can answer synchronously.

## 0.1.1

### Patch Changes

- [#207](https://github.com/DavideCarvalho/nestjs-agent/pull/207) [`13b50e2`](https://github.com/DavideCarvalho/nestjs-agent/commit/13b50e24461194aec197e96b82bbee1afc4570c8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `ctx.emitUi(component, props, { id?, version? })`: a tool pushes a generative-UI component. It
  streams live as a `ui` frame (inline, durable, and from the worker serving a dispatched tool step)
  and is persisted on the assistant message through the new optional `AgentStore.setMessageUi`
  (implemented by the Drizzle, MikroORM and in-memory stores), once per step. The pushes ride the tool
  step's journaled result, so a durable replay neither re-streams nor re-persists them; a tool that
  pushes nothing journals exactly what it did before. `ui` frames and persisted components gain an
  optional `toolCallId`, and a reloaded message places such a component right after its call's tool
  part (React: `TranscriptUiBlock.toolCallId`). `ToolSpec.terminal` / `@AiTool({ terminal: true })`
  ends the turn after a successful call, settled in the call's `persist:toolcall` checkpoint.

  `@dudousxd/nestjs-agent-genui` requires core >= 0.22, where its tools push through `ctx.emitUi` and
  `terminal` takes effect.

## 0.1.0

### Minor Changes

- [#205](https://github.com/DavideCarvalho/nestjs-agent/pull/205) [`a203035`](https://github.com/DavideCarvalho/nestjs-agent/commit/a2030354cc247a68cf3f0f73e8caf3fa714f87ca) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - New package: a headless, isomorphic generative-UI catalog. `defineComponent` / `defineCatalog` with
  Standard Schema or JSON Schema props (a built-in validator, or `ajvValidator(ajv)`),
  `catalogToModelText`, `componentToText` plain-text fallbacks, tree validation and
  `treeToFlatSpec`, and `genuiTools(catalog, { mode: 'per-component' | 'tree', terminal })`, which
  builds lib tools that validate against the catalog and push `ui` frames through `ctx.emitUi`.
  Optional builtin definitions (no visuals) under `/builtins`.
