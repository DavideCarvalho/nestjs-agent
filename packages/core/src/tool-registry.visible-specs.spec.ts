import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DefaultRolesPolicy, type ToolPresentation, ToolRegistry } from './index.js';

const presentation: ToolPresentation = {
  label: 'Database query',
  running: 'Querying {table}',
  done: 'Queried {table}',
  icon: 'database',
  result: { kind: 'table', rows: 'rows', columns: [{ path: 'id', label: 'ID' }] },
};

function registry(): ToolRegistry {
  const reg = new ToolRegistry();
  const execute = async () => ({});
  reg.register(
    { name: 'query', kind: 'read', description: 'q', inputSchema: z.object({}), presentation },
    { execute },
  );
  reg.register(
    {
      name: 'purge',
      kind: 'action',
      description: 'p',
      inputSchema: z.object({}),
      roles: ['ADMIN'],
    },
    { execute },
  );
  reg.register(
    { name: 'hidden', kind: 'read', description: 'h', inputSchema: z.object({}), enabled: false },
    { execute },
  );
  reg.register(
    { name: 'mine', kind: 'read', description: 'm', inputSchema: z.object({}) },
    { execute, canUse: (actor) => actor.id === 'owner' },
  );
  return reg;
}

describe('ToolRegistry.visibleSpecs', () => {
  const policy = new DefaultRolesPolicy(['USER', 'ADMIN']);

  it('returns whole specs, presentation included, behind the same gates the model sees', async () => {
    const specs = await registry().visibleSpecs({ id: 'u1', roles: ['USER'] }, policy);
    expect(specs.map((spec) => spec.name)).toEqual(['query']);
    expect(specs[0]?.presentation).toEqual(presentation);
  });

  it('never disagrees with definitionsFor', async () => {
    const reg = registry();
    for (const actor of [
      { id: 'u1', roles: ['USER'] },
      { id: 'owner', roles: ['ADMIN'] },
    ]) {
      const visible = (await reg.visibleSpecs(actor, policy, ['query', 'purge', 'mine'])).map(
        (spec) => spec.name,
      );
      const offered = (await reg.definitionsFor(actor, policy, ['query', 'purge', 'mine'])).map(
        (definition) => definition.name,
      );
      expect(visible).toEqual(offered);
    }
  });
});
