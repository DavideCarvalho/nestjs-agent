import { expect, it } from 'vitest';
import { z } from 'zod';
import { defineCatalog } from './genui/catalog.js';
import { createNegotiatedUiCollector } from './negotiated-tool-ui.js';
it('validates unsupported UI and collects complete text fallback instead of emitting a component', async () => {
  const catalog = defineCatalog([
    {
      name: 'Note',
      title: 'Note',
      description: 'Note',
      props: z.object({ text: z.string() }),
      fallbackText: (props) => String(props.text),
    },
  ]);
  const collector = createNegotiatedUiCollector(
    'c',
    { actor: { id: 'a' }, threadId: 't', uiCapabilities: { components: [] } },
    async () => catalog,
  );
  await collector.emit('Note', { text: 'Readable' });
  expect(collector.components()).toEqual([]);
  expect(collector.text()).toBe('Readable');
  await expect(collector.emit('Note', { text: 4 })).rejects.toThrow();
  await expect(collector.emit('Unauthorized', {})).rejects.toThrow();
});
it('omits a tool whose current describe scope marks renderer capability unavailable', async () => {
  const { ToolRegistry, DefaultRolesPolicy } = await import('./tool-registry.js');
  const registry = new ToolRegistry();
  registry.register(
    { name: 'show', kind: 'read', description: 'show', inputSchema: z.object({}) },
    { execute: async () => null, describe: () => ({ available: false }) },
  );
  expect(
    await registry.definitionsFor({ id: 'a' }, new DefaultRolesPolicy(), undefined, {
      uiCapabilities: { components: [] },
    }),
  ).toEqual([]);
});
it('snapshots emission props before asynchronous catalog resolution', async () => {
  const catalog = defineCatalog([
    {
      name: 'Note',
      title: 'Note',
      description: 'Note',
      props: z.object({ text: z.string() }),
      fallbackText: (props) => String(props.text),
    },
  ]);
  let resume: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const collector = createNegotiatedUiCollector(
    'c',
    { actor: { id: 'a' }, threadId: 't' },
    async () => {
      await wait;
      return catalog;
    },
  );
  const props = { text: 'Original' };
  const emission = collector.emit('Note', props);
  props.text = 'Changed';
  resume?.();
  await emission;
  expect(collector.components()[0]?.props).toEqual({ text: 'Original' });
});
