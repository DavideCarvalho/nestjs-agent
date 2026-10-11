import { genuiTools } from '@dudousxd/nestjs-agent-core/genui';
import { defineCatalog } from '@dudousxd/nestjs-agent-core/genui';
import { BUILTIN_COMPONENTS, Sandbox } from '@dudousxd/nestjs-agent-core/genui/builtins';
import type { Gate } from '@dudousxd/nestjs-authz';
import { describe, expect, it } from 'vitest';
import { AuthzRolesPolicy } from './authz-roles-policy.js';

describe('the UI tools under AuthzRolesPolicy', () => {
  it('genuiTools({ ability }) lets the gate decide; without it, a deny fallback denies them', async () => {
    const asked: string[] = [];
    const gate = {
      forUser: () => ({
        allows: async (ability: string) => {
          asked.push(ability);
          return ability === 'genui.use';
        },
      }),
    } as unknown as Gate;
    const policy = new AuthzRolesPolicy(gate, { emptyRoles: 'deny' });
    const catalog = defineCatalog([...BUILTIN_COMPONENTS, Sandbox]);
    const actor = { id: 'u1', roles: [] };
    for (const tool of genuiTools(catalog, { componentTools: ['Sandbox'] }))
      expect(await policy.can(actor, tool.spec)).toBe(false);
    for (const tool of genuiTools(catalog, { componentTools: ['Sandbox'], ability: 'genui.use' }))
      expect(await policy.can(actor, tool.spec)).toBe(true);
    expect(asked).toEqual(['genui.use', 'genui.use']);
  });
});
