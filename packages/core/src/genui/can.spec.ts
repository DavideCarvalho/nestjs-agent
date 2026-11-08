import { describe, expect, it } from 'vitest';
import { BUILTIN_COMPONENTS } from './builtins.js';
import { defineCatalog } from './catalog.js';
import { Sandbox } from './sandbox.js';
import { genuiToolCan, genuiTools } from './tools.js';

const catalog = defineCatalog([...BUILTIN_COMPONENTS, Sandbox]);

class GenuiPolicy {
  use() {
    return true;
  }
  render() {
    return true;
  }
  sandbox() {
    return true;
  }
  show() {
    return true;
  }
}

const USE = [{ policy: GenuiPolicy, ability: 'use' }];
const RENDER = [{ policy: GenuiPolicy, ability: 'render' }];
const SANDBOX = [{ policy: GenuiPolicy, ability: 'sandbox' }];
const SHOW = [{ policy: GenuiPolicy, ability: 'show' }];

describe('genuiTools({ can }) — the authorization the UI tools require', () => {
  it('requires none by default', () => {
    const tools = genuiTools(catalog, { componentTools: ['Sandbox'] });
    expect(tools.map((tool) => [tool.spec.name, tool.spec.can])).toEqual([
      ['ui__render', undefined],
      ['ui__sandbox', undefined],
    ]);
  });

  it('one list for every tool, a map by tool name, or a function of the tool', () => {
    expect(
      genuiTools(catalog, { componentTools: ['Sandbox'], can: USE, showTool: true }).map(
        (tool) => tool.spec.can,
      ),
    ).toEqual([USE, USE, USE]);
    expect(
      genuiTools(catalog, {
        componentTools: ['Sandbox'],
        can: { ui__render: RENDER },
      }).map((tool) => [tool.spec.name, tool.spec.can]),
    ).toEqual([
      ['ui__render', RENDER],
      ['ui__sandbox', undefined],
    ]);
    const perComponent = genuiTools(catalog, {
      mode: 'per-component',
      can: ({ component }) => (component === 'Sandbox' ? SANDBOX : SHOW),
    });
    expect(perComponent.find((tool) => tool.spec.name === 'ui__show_sandbox')?.spec.can).toBe(
      SANDBOX,
    );
    expect(genuiToolCan(undefined, { name: 'ui__render' })).toBeUndefined();
  });
});
