import type { AiToolCtx } from '@dudousxd/nestjs-agent-core';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { BUILTIN_COMPONENTS, LAYOUT_COMPONENTS } from './builtins.js';
import { defineCatalog, defineComponent } from './catalog.js';
import { genuiTools } from './tools.js';
import { GENUI_TREE_COMPONENT } from './tree.js';

const baseCtx: AiToolCtx = {
  actor: { ref: 'u1', roles: [] } as unknown as AiToolCtx['actor'],
  threadId: 't1',
  runId: 'r1',
  requestId: 'r1',
};

function ctxWithEmit() {
  const emitUi = vi.fn(
    async (_component: string, _props: Record<string, unknown>, options?: { id?: string }) => ({
      id: options?.id ?? 'call-1:ui:0',
    }),
  );
  return { ctx: { ...baseCtx, emitUi } as AiToolCtx, emitUi };
}

const deal = defineComponent({
  name: 'DealCard',
  title: 'Deal',
  description: 'A deal.',
  props: z.object({ name: z.string(), stage: z.string().default('lead') }),
  version: 2,
});
const catalog = defineCatalog([...BUILTIN_COMPONENTS, ...LAYOUT_COMPONENTS, deal]);

describe('genuiTools per-component', () => {
  const tools = genuiTools(catalog, { roles: ['member'] });

  it('makes one read tool per model component, named ui__show_<snake>', () => {
    expect(tools.map((tool) => tool.spec.name)).toContain('ui__show_data_table');
    expect(tools.map((tool) => tool.spec.name)).toContain('ui__show_deal_card');
    const table = tools.find((tool) => tool.spec.name === 'ui__show_data_table');
    expect(table?.spec).toMatchObject({
      kind: 'read',
      roles: ['member'],
      presentation: { label: 'Data table', result: { kind: 'elsewhere' } },
    });
    expect(table?.spec.terminal).toBeUndefined();
  });

  it('exposes a JSON Schema props schema to the model and validates through it', async () => {
    const table = tools.find((tool) => tool.spec.name === 'ui__show_data_table');
    const standard = table?.spec.inputSchema['~standard'] as unknown as {
      validate(value: unknown): { issues?: unknown[] };
      jsonSchema: { input(options: unknown): unknown };
    };
    expect(standard.jsonSchema.input({ target: 'draft-07' })).toBe(catalog.get('DataTable')?.props);
    expect(standard.validate({ columns: [], rows: [] }).issues).toHaveLength(1);
  });

  it('pushes the validated props through ctx.emitUi with the component version', async () => {
    const { ctx, emitUi } = ctxWithEmit();
    const tool = tools.find((each) => each.spec.name === 'ui__show_deal_card');
    const output = await tool?.handler.execute({ name: 'Acme' }, ctx);
    expect(emitUi).toHaveBeenCalledWith(
      'DealCard',
      { name: 'Acme', stage: 'lead' },
      { version: 2 },
    );
    expect(output).toEqual({ shown: 'DealCard', id: 'call-1:ui:0' });
  });

  it('refuses invalid props with a message the model can act on', async () => {
    const { ctx, emitUi } = ctxWithEmit();
    const tool = tools.find((each) => each.spec.name === 'ui__show_callout');
    await expect(tool?.handler.execute({ tone: 'loud' }, ctx)).rejects.toThrow(
      'invalid Callout props: text: is required; tone: must be one of "info", "success", "warning", "danger"',
    );
    expect(emitUi).not.toHaveBeenCalled();
  });

  it('returns the props when the context cannot push (older core, MCP surface)', async () => {
    const tool = tools.find((each) => each.spec.name === 'ui__show_heading');
    await expect(tool?.handler.execute({ text: 'Hi' }, baseCtx)).resolves.toEqual({
      shown: 'Heading',
      props: { text: 'Hi' },
    });
  });

  it('stamps terminal and honours a custom prefix', () => {
    const [first] = genuiTools(catalog, { terminal: true, namePrefix: 'show_' });
    expect(first?.spec).toMatchObject({ name: 'show_data_table', terminal: true });
  });
});

describe('genuiTools tree', () => {
  const [tool] = genuiTools(catalog, {
    mode: 'tree',
    terminal: true,
    treeToolName: 'renderResult',
  });

  it('is one terminal tool describing the catalog', () => {
    expect(tool?.spec).toMatchObject({ name: 'renderResult', kind: 'read', terminal: true });
    expect(tool?.spec.description).toContain('- DataTable:');
    expect(tool?.spec.description).toContain('takes children');
  });

  it('validates the tree in inputSchema (async) so the registry refuses a bad one', async () => {
    const result = await tool?.spec.inputSchema['~standard'].validate({
      type: 'Card',
      props: {},
      children: [{ type: 'Text', props: {} }],
    });
    expect(result?.issues?.[0]).toMatchObject({ path: ['children', 0, 'props', 'text'] });
  });

  it('pushes the tree as one genui:tree frame', async () => {
    const { ctx, emitUi } = ctxWithEmit();
    const root = { type: 'Stack', props: {}, children: [{ type: 'Text', props: { text: 'hi' } }] };
    await expect(tool?.handler.execute(root, ctx)).resolves.toEqual({
      shown: GENUI_TREE_COMPONENT,
      id: 'call-1:ui:0',
    });
    expect(emitUi).toHaveBeenCalledWith(GENUI_TREE_COMPONENT, { root }, {});
  });
});
