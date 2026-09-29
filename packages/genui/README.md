# `@dudousxd/nestjs-agent-genui`

> 🪺 Part of the [Aviary](https://davidecarvalho.github.io/aviary) · generative UI for [`@dudousxd/nestjs-agent`](https://www.npmjs.com/package/@dudousxd/nestjs-agent).

A **catalog** of components a model may push into a conversation, and the tools that push them.
Headless and isomorphic: it ships definitions (name, props schema, what the model is told, a
plain-text fallback), never visuals. Each app renders the components with its own look, keyed by
name — `@dudousxd/nestjs-agent-react/genui` does the lookup.

A pushed component travels as the stream's `ui` frame (`{ id, component, props, version? }`, see
[docs/stream-protocol.md](../../docs/stream-protocol.md)) and is persisted on the assistant message,
so a reload shows what the live stream did.

## Install

```bash
pnpm add @dudousxd/nestjs-agent-genui
```

## Define a catalog

Props are a [Standard Schema](https://standardschema.dev) (Zod, Valibot, ArkType) or a plain JSON
Schema object — JSON Schema is data, so a catalog can live in a database (tenant components).

```ts
import { defineCatalog, defineComponent } from '@dudousxd/nestjs-agent-genui';
import { BUILTIN_COMPONENTS, LAYOUT_COMPONENTS } from '@dudousxd/nestjs-agent-genui/builtins';
import { z } from 'zod';

const DealCard = defineComponent({
  name: 'DealCard',
  title: 'Deal',
  description: 'One deal in the pipeline: name, stage, amount.',
  props: z.object({ name: z.string(), stage: z.string(), amount: z.number() }),
  fallbackText: (p) => `*${p.name}* — ${p.stage} (${p.amount})`,
  version: 1,
});

export const catalog = defineCatalog([...BUILTIN_COMPONENTS, ...LAYOUT_COMPONENTS, DealCard]);
```

| Field | Meaning |
|---|---|
| `name` | Registry key the client resolves (`DataTable`). Letters and digits. |
| `title`, `description` | What people and the model are told. |
| `props` | Standard Schema or JSON Schema. |
| `children` | Takes nested elements (layouts) in tree mode. |
| `fallbackText(props)` | Plain text / Slack mrkdwn for channels that cannot draw it. |
| `internal` | Pushed by the server only; never offered to the model. |
| `version` | Schema version of `props`, stamped on every frame. |

JSON Schema props are checked by a small built-in validator (the keywords component props use).
For full JSON Schema, hand the catalog your Ajv:

```ts
import Ajv from 'ajv';
defineCatalog(components, { jsonSchemaValidator: ajvValidator(new Ajv({ allErrors: true })) });
```

`catalog.validate(name, props)` → `{ ok: true, value } | { ok: false, issues }` (an unknown
component is a failure, not a throw).

## Give the model tools

```ts
import { genuiTools } from '@dudousxd/nestjs-agent-genui';
import { provideAgentTool } from '@dudousxd/nestjs-agent';

// One tool per component: ui__show_data_table, ui__show_deal_card, …
const perComponent = genuiTools(catalog);
// Or ONE tool whose input is a nested tree composed from the catalog (json-render's nested shape).
const tree = genuiTools(catalog, { mode: 'tree', treeToolName: 'renderResult', terminal: true });

@Module({ providers: [...perComponent.map((tool) => provideAgentTool(tool))] })
export class GenuiToolsModule {}
```

| Option | Default | |
|---|---|---|
| `mode` | `'per-component'` | `'tree'` → one tool, input `{ type, props, children? }` |
| `terminal` | `false` | The turn ends once a call succeeds (no model call to narrate the UI). |
| `namePrefix` | `'ui__show_'` | Per-component tool names. |
| `treeToolName` | `'ui__render'` | Tree tool name. |
| `treeInstructions` | | Prepended to the tree tool's description. |
| `treeLimits` | `{ maxDepth: 12, maxNodes: 200 }` | |
| `roles` | | `ToolSpec.roles` for every tool. |
| `presentation(component)` | label/running/done from `title`, `result: elsewhere` | |

Every call is validated against the catalog; a refused call reaches the model as a tool error
naming each problem (`columns: must have at least 1 items`), so it can fix it. A valid call pushes
through `ctx.emitUi` — per-component tools push `{ component: <name>, props }`, the tree tool pushes
`{ component: 'genui:tree', props: { root } }` (`GENUI_TREE_COMPONENT`). The model is told
`{ shown, id }`.

In tree mode a `children` array a model sent as a JSON string is parsed back into the array it
meant; everything else must match the catalog.

## Text and model helpers

- `catalogToModelText(catalog, { mode })` — the catalog as text for a prompt: each component, its
  description and a compact props signature (`{ title?: string, rows: object[] }`).
- `componentToText(catalog, component, props)` — a pushed component as plain text (its
  `fallbackText`, else the props as JSON). Handles `genui:tree` frames node by node.
- `treeToText`, `validateTree`, `treeJsonSchema`, `treeToFlatSpec` (json-render flat spec).

## Builtins

`@dudousxd/nestjs-agent-genui/builtins` — definitions only: `DataTable`, `Chart`, `KpiCards`,
`SourceCards`, `Checklist`, `Timeline`, `CodeBlock`, `Diff`, `Callout` (`BUILTIN_COMPONENTS`) and
`Stack`, `Card`, `Heading`, `Text`, `Badge`, `Link`, `Image` (`LAYOUT_COMPONENTS`; `Stack` and `Card`
take children). Each has a JSON Schema and a Slack-friendly `fallbackText`. Render them however
your app looks.
