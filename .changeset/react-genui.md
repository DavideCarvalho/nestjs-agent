---
'@dudousxd/nestjs-agent-react': minor
'@dudousxd/nestjs-agent-genui': minor
---

`@dudousxd/nestjs-agent-react/genui`: headless rendering of server-pushed components. `<GenerativeUI
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
