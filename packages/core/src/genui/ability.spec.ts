import { describe, expect, it } from 'vitest';
import { BUILTIN_COMPONENTS } from './builtins.js';
import { defineCatalog } from './catalog.js';
import { Sandbox } from './sandbox.js';
import { genuiToolAbility, genuiTools } from './tools.js';

const catalog = defineCatalog([...BUILTIN_COMPONENTS, Sandbox]);

describe('genuiTools({ ability }) — the UI tools under an ability-aware authorizer', () => {
  it('declares no ability by default (an ability-only authorizer denies them)', () => {
    const tools = genuiTools(catalog, { componentTools: ['Sandbox'] });
    expect(tools.map((tool) => [tool.spec.name, tool.spec.ability])).toEqual([
      ['ui__render', undefined],
      ['ui__sandbox', undefined],
    ]);
  });

  it('one ability for every tool, a map by tool name, or a function of the tool', () => {
    expect(
      genuiTools(catalog, {
        componentTools: ['Sandbox'],
        ability: 'genui.use',
        showTool: true,
      }).map((tool) => tool.spec.ability),
    ).toEqual(['genui.use', 'genui.use', 'genui.use']);
    expect(
      genuiTools(catalog, {
        componentTools: ['Sandbox'],
        ability: { ui__render: 'genui.render' },
      }).map((tool) => [tool.spec.name, tool.spec.ability]),
    ).toEqual([
      ['ui__render', 'genui.render'],
      ['ui__sandbox', undefined],
    ]);
    const perComponent = genuiTools(catalog, {
      mode: 'per-component',
      ability: ({ component }) => (component === 'Sandbox' ? 'genui.sandbox' : 'genui.show'),
    });
    expect(perComponent.find((tool) => tool.spec.name === 'ui__show_sandbox')?.spec.ability).toBe(
      'genui.sandbox',
    );
    expect(genuiToolAbility(undefined, { name: 'ui__render' })).toBeUndefined();
  });
});
