import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { ToolHandler } from './spi/tool.js';
import type { ToolSpec } from './types.js';

export interface FunctionalTool<I = unknown, O = unknown> {
  spec: ToolSpec;
  handler: ToolHandler<I, O>;
}

export type FunctionalToolDefinition<I, O> = Omit<ToolSpec, 'inputSchema' | 'kind'> & {
  input: StandardSchemaV1<unknown, I>;
  kind?: ToolSpec['kind'];
} & ToolHandler<I, O>;

/** Framework-independent authoring; every method keeps the author's object as its receiver. */
export function createFunctionalTool<I, O>(
  definition: FunctionalToolDefinition<I, O>,
): FunctionalTool<I, O> {
  const { input, execute, present, preflight, isEnabled, canUse, describe, kind, ...metadata } =
    definition;
  return {
    spec: { ...metadata, kind: kind ?? 'read', inputSchema: input },
    handler: {
      execute: execute.bind(definition),
      ...(present === undefined ? {} : { present: present.bind(definition) }),
      ...(preflight === undefined ? {} : { preflight: preflight.bind(definition) }),
      ...(isEnabled === undefined ? {} : { isEnabled: isEnabled.bind(definition) }),
      ...(canUse === undefined ? {} : { canUse: canUse.bind(definition) }),
      ...(describe === undefined ? {} : { describe: describe.bind(definition) }),
    },
  };
}
