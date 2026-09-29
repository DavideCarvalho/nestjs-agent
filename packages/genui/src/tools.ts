import type {
  AiToolCtx,
  ToolHandler,
  ToolPresentation,
  ToolSpec,
} from '@dudousxd/nestjs-agent-core';
import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';
import { type Catalog, type ComponentDefinition, toolNameFor } from './catalog.js';
import {
  type GenuiIssue,
  type JsonSchema,
  formatIssues,
  isStandardSchema,
  validateProps,
} from './schema.js';
import { catalogToModelText } from './text.js';
import {
  GENUI_TREE_COMPONENT,
  type GenuiElement,
  type TreeLimits,
  treeJsonSchema,
  validateTree,
} from './tree.js';

/**
 * What a tool needs from its context to push a component: `ctx.emitUi` (core >= 0.22). Declared
 * structurally so the tools also type-check against an older core, where they fall back to
 * returning the props (see {@link GenuiToolOutput}).
 */
interface UiEmittingCtx {
  emitUi?(
    component: string,
    props: Record<string, unknown>,
    options?: { id?: string; version?: number },
  ): Promise<{ id: string }>;
}

/** A lib tool: register it with `provideAgentTool(tool)` (NestJS) or `registry.register(tool.spec, tool.handler)`. */
export interface GenuiTool {
  spec: ToolSpec & { terminal?: boolean };
  handler: ToolHandler;
}

/**
 * What a genui tool returns to the model. `shown` names what was pushed; `id` is the `ui` frame's
 * id. `props` is present only when the context could not push a frame (no `ctx.emitUi` — an older
 * core, or a surface such as MCP that has no stream), so a client can still render the call from
 * its own tool part.
 */
export interface GenuiToolOutput {
  shown: string;
  id?: string;
  props?: Record<string, unknown>;
}

export interface GenuiToolsOptions {
  /**
   * `per-component` (default): one tool per model-facing component, `ui__show_<snake>`, whose input
   * IS the component's props. `tree`: a single tool whose input is a nested
   * `{ type, props, children }` tree composed from the catalog (json-render's nested shape).
   */
  mode?: 'per-component' | 'tree';
  /**
   * The model's turn ends once a genui call succeeds — no further model call to narrate what the UI
   * already shows. Stamped as `spec.terminal`; honoured by core >= 0.22, ignored by older ones.
   */
  terminal?: boolean;
  /** Tool-name prefix for `per-component`. Default `ui__show_`. */
  namePrefix?: string;
  /** Tool name for `tree`. Default `ui__render`. */
  treeToolName?: string;
  /** Extra text prepended to the tree tool's description (when to call it, house rules). */
  treeInstructions?: string;
  /** Size limits for `tree`. */
  treeLimits?: TreeLimits;
  /** Roles allowed to call the tools (the `ToolSpec.roles` gate). Undefined → the roles policy default. */
  roles?: string[];
  /** Override the generated presentation per component (or for the tree tool, under its tool name). */
  presentation?: (component: string) => ToolPresentation | undefined;
}

/**
 * Tools that let a model push catalog components into the conversation as `ui` frames. Each call
 * validates its input against the catalog (a refused call reaches the model as a tool error it can
 * fix) and then pushes through `ctx.emitUi`, which streams the frame live and persists it on the
 * assistant message.
 */
export function genuiTools(catalog: Catalog, options: GenuiToolsOptions = {}): GenuiTool[] {
  return options.mode === 'tree'
    ? [treeTool(catalog, options)]
    : catalog.modelComponents().map((component) => componentTool(catalog, component, options));
}

function componentTool(
  catalog: Catalog,
  component: ComponentDefinition<any>,
  options: GenuiToolsOptions,
): GenuiTool {
  const presentation = options.presentation?.(component.name) ?? {
    label: component.title,
    running: `Showing ${lowerFirst(component.title)}`,
    done: `Showed ${lowerFirst(component.title)}`,
    result: { kind: 'elsewhere' as const },
  };
  const inputSchema = isStandardSchema(component.props)
    ? component.props
    : jsonStandardSchema(component.props, (value) =>
        catalog.validator.validate(component.props as JsonSchema, value),
      );
  return {
    spec: {
      name: toolNameFor(component.name, options.namePrefix),
      kind: 'read',
      description: `Show the user a ${component.title} (${component.name}). ${component.description}`,
      inputSchema,
      presentation,
      ...(options.roles !== undefined ? { roles: options.roles } : {}),
      ...(options.terminal === true ? { terminal: true } : {}),
    },
    handler: {
      async execute(input: unknown, ctx: AiToolCtx): Promise<GenuiToolOutput> {
        // The registry already ran `inputSchema`; validating again here is what a host that calls
        // the handler directly (tests, another surface) gets for free, and applies the schema's own
        // output (defaults) for a Standard Schema.
        const validated = await validateProps(component.props, input, catalog.validator);
        if (!validated.ok) {
          throw new Error(`invalid ${component.name} props: ${formatIssues(validated.issues)}`);
        }
        const props = validated.value as Record<string, unknown>;
        return push(ctx, component.name, props, component.version);
      },
    },
  };
}

function treeTool(catalog: Catalog, options: GenuiToolsOptions): GenuiTool {
  const name = options.treeToolName ?? 'ui__render';
  const schema = treeJsonSchema(catalog);
  const presentation = options.presentation?.(name) ?? {
    label: 'Answer',
    running: 'Laying out the answer',
    done: 'Laid out the answer',
    result: { kind: 'elsewhere' as const },
  };
  const description = [
    options.treeInstructions ?? 'Render a rich UI to present the answer to the user.',
    catalogToModelText(catalog, { mode: 'tree' }),
  ].join('\n');
  return {
    spec: {
      name,
      kind: 'read',
      description,
      inputSchema: asyncJsonStandardSchema(schema, async (value) => {
        const result = await validateTree(catalog, value, options.treeLimits);
        return result.ok ? { value: result.value } : { issues: result.issues };
      }),
      presentation,
      ...(options.roles !== undefined ? { roles: options.roles } : {}),
      ...(options.terminal === true ? { terminal: true } : {}),
    },
    handler: {
      async execute(input: unknown, ctx: AiToolCtx): Promise<GenuiToolOutput> {
        const result = await validateTree(catalog, input, options.treeLimits);
        if (!result.ok) {
          throw new Error(`invalid UI tree: ${formatIssues(result.issues)}`);
        }
        const root: GenuiElement = result.value;
        return push(ctx, GENUI_TREE_COMPONENT, { root });
      },
    },
  };
}

async function push(
  ctx: AiToolCtx,
  component: string,
  props: Record<string, unknown>,
  version?: number,
): Promise<GenuiToolOutput> {
  const emit = (ctx as AiToolCtx & UiEmittingCtx).emitUi;
  if (emit === undefined) {
    return { shown: component, props };
  }
  const { id } = await emit.call(ctx, component, props, version !== undefined ? { version } : {});
  return { shown: component, id };
}

function lowerFirst(text: string): string {
  return text.length > 0 ? `${text[0]?.toLowerCase()}${text.slice(1)}` : text;
}

type JsonStandardSchema = StandardSchemaV1 & StandardJSONSchemaV1;

/**
 * A JSON Schema presented as a Standard Schema WITH the Standard JSON Schema extension, so the lib
 * validates tool input through `~standard.validate` and the AI SDK adapter hands the model the
 * schema itself (it reads `~standard.jsonSchema.input`).
 */
export function jsonStandardSchema(
  schema: JsonSchema,
  validate: (value: unknown) => GenuiIssue[],
): JsonStandardSchema {
  return asyncJsonStandardSchema(schema, (value) => {
    const issues = validate(value);
    return issues.length > 0 ? { issues } : { value };
  });
}

function asyncJsonStandardSchema(
  schema: JsonSchema,
  validate: (
    value: unknown,
  ) =>
    | { value: unknown; issues?: undefined }
    | { issues: GenuiIssue[] }
    | Promise<{ value: unknown; issues?: undefined } | { issues: GenuiIssue[] }>,
): JsonStandardSchema {
  const toResult = (
    outcome: { value: unknown; issues?: undefined } | { issues: GenuiIssue[] },
  ): StandardSchemaV1.Result<unknown> =>
    outcome.issues !== undefined
      ? {
          issues: outcome.issues.map((issue) => ({ message: issue.message, path: issue.path })),
        }
      : { value: (outcome as { value: unknown }).value };
  return {
    '~standard': {
      version: 1,
      vendor: 'nestjs-agent-genui',
      validate(value) {
        const outcome = validate(value);
        return outcome instanceof Promise ? outcome.then(toResult) : toResult(outcome);
      },
      jsonSchema: {
        input: () => schema,
        output: () => schema,
      },
    },
  } as JsonStandardSchema;
}
