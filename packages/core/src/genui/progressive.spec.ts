import { describe, expect, it } from 'vitest';
import { parsePartialJson } from '../partial-json.js';
import type { PartialToolInput, ToolInputPreview } from '../spi/tool.js';
import { Card, Chart, DataTable, KpiCards, Stack } from './builtins.js';
import { Sandbox, defineCatalog, defineComponent, genuiTools, partialTree } from './index.js';

const catalog = defineCatalog([Stack, Card, Chart, DataTable, KpiCards]);

const dashboard = {
  type: 'Card',
  props: { title: 'Sales dashboard' },
  children: [
    { type: 'KpiCards', props: { items: [{ label: 'Revenue', value: '$9k' }] } },
    {
      type: 'Chart',
      props: {
        type: 'bar',
        xKey: 'month',
        series: [{ key: 'revenue' }],
        data: [
          { month: 'Jan', revenue: 1 },
          { month: 'Feb', revenue: 2 },
        ],
      },
    },
  ],
};

function partial(text: string): PartialToolInput {
  const parsed = parsePartialJson(text);
  if (parsed === undefined) throw new Error(`not JSON: ${text}`);
  return {
    value: parsed.value,
    done: parsed.complete,
    isOpen: parsed.isOpen,
    pendingMember: parsed.pendingMember,
  };
}

const prefix = (value: unknown, until: string) => {
  const text = JSON.stringify(value);
  const at = text.indexOf(until);
  if (at < 0) throw new Error(`no ${until}`);
  return text.slice(0, at + until.length);
};

describe('partialTree', () => {
  it('draws the nodes whose type has arrived, flagged incomplete while open, with positional ids', () => {
    const tree = partialTree(catalog, partial(prefix(dashboard, '"label":"Rev')), {
      streaming: 'partial',
    });
    expect(tree).toEqual({
      root: {
        id: 'root',
        type: 'Card',
        props: { title: 'Sales dashboard' },
        incomplete: true,
        children: [
          {
            id: 'root.0',
            type: 'KpiCards',
            props: { items: [{ label: 'Rev' }] },
            incomplete: true,
          },
        ],
      },
    });
  });

  it('keeps every id stable as the tree grows', () => {
    const text = JSON.stringify(dashboard);
    const ids = new Map<string, string>();
    for (let cut = 1; cut <= text.length; cut += 1) {
      const tree = partialTree(catalog, partial(text.slice(0, cut)), { streaming: 'partial' });
      expect(tree, `prefix ${cut}`).not.toBeNull();
      const visit = (node: { id: string; type: string; children?: unknown[] } | null) => {
        if (node === null) return;
        const seen = ids.get(node.id);
        if (seen !== undefined) expect(seen).toBe(node.type);
        ids.set(node.id, node.type);
        for (const child of node.children ?? []) visit(child as never);
      };
      visit(tree?.root ?? null);
    }
    expect([...ids]).toEqual([
      ['root', 'Card'],
      ['root.0', 'KpiCards'],
      ['root.1', 'Chart'],
    ]);
    // Closed: no node is flagged any more.
    const whole = partialTree(catalog, partial(text), { streaming: 'partial' });
    expect(JSON.stringify(whole)).not.toMatch(/incomplete|held/);
  });

  it('never takes a type cut mid-way for a component', () => {
    const tree = partialTree(catalog, partial('{"type":"Card","children":[{"type":"Char'), {
      streaming: 'partial',
    });
    expect(tree?.root?.children).toBeUndefined();
    expect(partialTree(catalog, partial('{"type":"Ca'), { streaming: 'partial' })).toEqual({
      root: null,
    });
  });

  it('holds a component that streams complete as a placeholder until its subtree closes', () => {
    const held = defineCatalog([Card, KpiCards, { ...Chart, streaming: 'complete' }]);
    const writing = partialTree(held, partial(prefix(dashboard, '"month":"Jan"')), {
      streaming: 'partial',
    });
    expect(writing?.root?.children?.[1]).toEqual({
      id: 'root.1',
      type: 'Chart',
      props: {},
      incomplete: true,
      held: true,
    });
    const closed = partialTree(held, partial(prefix(dashboard, '"revenue":2}]}}')), {
      streaming: 'partial',
    });
    expect(closed?.root?.children?.[1]).toEqual({
      id: 'root.1',
      type: 'Chart',
      props: dashboard.children[1]?.props,
    });
  });

  it('lets a component that streams partial itself stream inside a complete layout', () => {
    const nested = defineCatalog([Stack, Card, Sandbox]);
    const layout = {
      type: 'Stack',
      props: { direction: 'column' },
      children: [
        {
          type: 'Card',
          props: { title: 'Split the bill' },
          children: [
            {
              type: 'Sandbox',
              props: {
                title: 'Bill splitter',
                initialHeight: 240,
                html: '<form id="f"><input name="total"></form>',
                js: 'document.getElementById("f")',
              },
            },
          ],
        },
      ],
    };
    // The layout (complete, by default) is drawn once its own props are whole; the sandbox streams.
    const writing = partialTree(nested, partial(prefix(layout, '<input')));
    expect(writing?.root).toMatchObject({
      id: 'root',
      type: 'Stack',
      props: { direction: 'column' },
      incomplete: true,
      children: [
        {
          id: 'root.0',
          type: 'Card',
          props: { title: 'Split the bill' },
          incomplete: true,
          children: [{ id: 'root.0.0', type: 'Sandbox', incomplete: true }],
        },
      ],
    });
    expect(writing?.root?.held).toBeUndefined();
    const sandbox = writing?.root?.children?.[0]?.children?.[0];
    expect(sandbox?.props.title).toBe('Bill splitter');
    // Before the layout's props have closed, it is held as before.
    expect(partialTree(nested, partial(prefix(layout, '"direction":"col')))?.root).toMatchObject({
      held: true,
    });
    // A complete layout with nothing streaming inside is still held until it closes.
    const plain = defineCatalog([Stack, Card, KpiCards]);
    expect(partialTree(plain, partial(prefix(dashboard, '"label":"Rev')))?.root).toMatchObject({
      held: true,
      props: {},
    });
  });

  it('stops (null) at what can no longer become a tree this catalog draws', () => {
    const options = { streaming: 'partial' as const };
    expect(partialTree(catalog, partial('{"type":"Pie","props":{'), options)).toBeNull();
    expect(
      partialTree(
        catalog,
        partial('{"type":"Chart","props":{},"children":[{"type":"Card"'),
        options,
      ),
    ).toBeNull();
    expect(partialTree(catalog, partial('{"type":"Card","children":[1,'), options)).toBeNull();
    const nested = { type: 'Stack', children: [{ type: 'Stack', children: [{ type: 'Stack' }] }] };
    expect(
      partialTree(catalog, partial(JSON.stringify(nested)), {
        ...options,
        limits: { maxDepth: 2 },
      }),
    ).toBeNull();
  });
});

describe('the ui__render preview', () => {
  const scope = { actor: { id: 'u1', roles: [] }, toolCallId: 'call-1' };

  it('is off by default: the tree appears when the call has run, as before', async () => {
    const [tool] = genuiTools(catalog, { mode: 'tree' });
    expect(await tool?.handler.previewInput?.(scope)).toBeUndefined();
  });

  it('is on with streaming partial, or when a component opts in', async () => {
    const [tool] = genuiTools(catalog, { mode: 'tree', streaming: 'partial' });
    const preview = await tool?.handler.previewInput?.(scope);
    expect(preview?.render(partial('{"type":"Card","props":{"title":"S'))).toEqual({
      component: 'genui:tree',
      version: 1,
      props: { root: { id: 'root', type: 'Card', props: { title: 'S' }, incomplete: true } },
    });
    const optIn = defineCatalog([Card, { ...KpiCards, streaming: 'partial' }]);
    const [opted] = genuiTools(optIn, { mode: 'tree' });
    expect(await opted?.handler.previewInput?.(scope)).toBeDefined();
  });

  it('answers nothing until a node is drawable, and withdraws (null) an undrawable tree', async () => {
    const [tool] = genuiTools(catalog, { mode: 'tree', streaming: 'partial' });
    const preview = (await tool?.handler.previewInput?.(scope)) as ToolInputPreview;
    expect(preview.render(partial('{"ty'))).toBeUndefined();
    expect(preview.render(partial('{"type":"Pie"'))).toBeNull();
  });

  it('previews only what the client declared it draws', async () => {
    const [tool] = genuiTools(catalog, { mode: 'tree', streaming: 'partial' });
    const preview = (await tool?.handler.previewInput?.({
      ...scope,
      uiCapabilities: { components: [{ name: 'Card', version: 1 }] },
    })) as ToolInputPreview;
    expect(preview.render(partial('{"type":"Card","props":{}'))).toBeDefined();
    // A Chart would make the final push degrade to text for this client: withdraw.
    expect(preview.render(partial('{"type":"Card","children":[{"type":"Chart"'))).toBeNull();
    // A text-only client (what a channel declares) gets no preview at all.
    expect(
      await tool?.handler.previewInput?.({ ...scope, uiCapabilities: { components: [] } }),
    ).toBeUndefined();
  });

  it('rejects an unknown streaming value on a component', () => {
    expect(() => defineComponent({ ...Card, streaming: 'eager' as never })).toThrow(/streaming/);
  });
});
