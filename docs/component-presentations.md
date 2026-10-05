# Component presentations and tool authoring

For the complete consumer walkthrough, including decorated classes, app-specific UI, and WhatsApp table/chart exports, see [Component registries and server rendering](./component-rendering.md).

Component definitions stay compatible with `defineComponent` and `defineCatalog`. A presentation is plain JSON (`component`, `props`, `version`, `fallbackText`); renderer functions and image/PDF bytes never belong in persisted frames.

```ts
import { createComponent, createComponentRegistry, table } from '@dudousxd/nestjs-agent-core/genui';
import { defineTool, provideAgentTool } from '@dudousxd/nestjs-agent';
import { z } from 'zod';

const greeting = createComponent({
  name: 'Greeting', title: 'Greeting', description: 'A greeting', version: 1,
  props: z.object({ text: z.string() }),
  fallbackText: ({ text }) => text,
});
const registry = createComponentRegistry().register(greeting.definition, {
  web: ({ text }) => text, // app-owned channel renderer
  text: ({ text }) => text,
});
const presentation = await greeting({ text: 'Hello' });
await registry.render(presentation, 'text');
registry.catalog; // compatible with existing GenUI catalog consumers
registry.manifest; // plain client metadata: names, versions and derivable portable props schemas

const records = defineTool({
  name: 'records', description: 'List records', input: z.object({ limit: z.number() }),
  execute: async ({ limit }) => repository.list(limit),
  present: async (result) => table({
    columns: [{ key: 'name', label: 'Name' }], rows: result,
  }),
});
// Add to Nest providers, or AgentModule.forRoot({ tools: [records], ... }).
provideAgentTool(records);
```

Create one registry per app or tenant. Duplicate names fail. `render` validates the authoritative portable props schema and version before calling any channel renderer. Missing channels use the registered `text` renderer or the definition's trusted text fallback. Renderer failures propagate; callers decide whether to retry or downgrade. `.prepare(presentation)` validates/normalizes wire props without rendering. Treat prepared props as normalized output; avoid validating them again with a non-idempotent input transform.

Factories infer Standard Schema input and output types. JSON Schema definitions can use `createComponent<MyProps>(definition)`. `table` accepts the existing DataTable `columns`/`rows` contract; `chart` accepts the existing Chart `type`, `xKey`, `series` and `data` contract.

When an input transformation changes shape or is not idempotent, declare `outputProps` for the portable normalized props. Factories validate input against `props`, then verify the produced JSON is stable under `outputProps ?? props`. Without a suitable output schema they reject the presentation rather than apply a transformation repeatedly during rendering or durable replay. Catalog validation and manifest schemas use `outputProps ?? props`.

```ts
const length = createComponent({
  name: 'Length', title: 'Length', description: 'String length',
  props: z.object({ text: z.string() }).transform(({ text }) => ({ length: text.length })),
  outputProps: z.object({ length: z.number() }),
  fallbackText: ({ length }) => `${length} characters`,
});
// Input is {text:string}; durable props are {length:number}.
await length({ text: 'hello' });
```

`ToolHandler<I, O>` accepts an optional `present(output: O, ctx)` returning one presentation, an array, or `undefined`, synchronously or asynchronously. Both `@AiTool` classes and functional tools keep their method receiver, including injected dependencies. Core-only hosts can use `createFunctionalTool` instead of Nest's `defineTool`.

The registry returns the original domain result. Denied and failed actions do not present. Already completed actions present without executing again; loop shortcuts journal their UI just like ordinary tool executions. Presentation and delivery errors are caught separately so they cannot fail or retry a successful action. Supply `ctx.onPresentationError(error, { toolName })` for host reporting; otherwise the library logs a distinct presentation warning. Reporting failures also retain the domain result. Every presentation in a batch is checked for a valid JSON-safe shape before sending any item through the existing `ctx.emitUi` stream.
