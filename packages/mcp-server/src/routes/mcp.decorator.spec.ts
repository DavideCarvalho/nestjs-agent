import { Controller, Get } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  Mcp,
  McpRouteDeclarationError,
  normalizeMcpRouteOptions,
  readMcpRouteMetadata,
} from './mcp.decorator.js';

@Controller('orders')
class OrdersController {
  @Get(':id')
  @Mcp({ kind: 'read', description: 'Read one order.', roles: ['ANALYST'] })
  findOne(): string {
    return 'order';
  }

  @Get('open')
  listOpen(): string {
    return 'open';
  }
}

describe('@Mcp', () => {
  it('files what it was given against the method', () => {
    expect(
      readMcpRouteMetadata({ prototype: OrdersController.prototype, methodName: 'findOne' }),
    ).toEqual({ kind: 'read', description: 'Read one order.', roles: ['ANALYST'] });
  });

  it('leaves a route that does not carry it alone', () => {
    expect(
      readMcpRouteMetadata({ prototype: OrdersController.prototype, methodName: 'listOpen' }),
    ).toBeUndefined();
  });
});

describe('normalizeMcpRouteOptions', () => {
  const route = 'OrdersController.cancel';

  it('refuses an omitted kind, naming the route and saying nothing is inferred', () => {
    // `kind` is required by the type, so a TypeScript caller does not compile. This is the same
    // refusal for everything the type is not present for — JS callers, transpile-only builds.
    let thrown: unknown;
    try {
      normalizeMcpRouteOptions({ options: { description: 'Cancel an order.' }, route });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(McpRouteDeclarationError);
    expect(thrown).toMatchObject({ route });
    expect(String(thrown)).toMatch(/explicit kind/);
    expect(String(thrown)).toMatch(/Nothing is inferred from the HTTP verb/);
    expect(String(thrown)).toMatch(/OrdersController\.cancel/);
  });

  it('refuses a kind that is not one of the two', () => {
    expect(() =>
      normalizeMcpRouteOptions({ options: { kind: 'agent', description: 'x' }, route }),
    ).toThrow(/explicit kind/);
  });

  it('refuses a missing or blank description', () => {
    expect(() => normalizeMcpRouteOptions({ options: { kind: 'read' }, route })).toThrow(
      /needs a description/,
    );
    expect(() =>
      normalizeMcpRouteOptions({ options: { kind: 'read', description: '   ' }, route }),
    ).toThrow(/needs a description/);
  });

  it('refuses malformed roles, names and abilities rather than passing them to the policy', () => {
    const base = { kind: 'read', description: 'Read one order.' };
    expect(() =>
      normalizeMcpRouteOptions({ options: { ...base, roles: 'ANALYST' }, route }),
    ).toThrow(/array of strings/);
    expect(() => normalizeMcpRouteOptions({ options: { ...base, name: '' }, route })).toThrow(
      /non-empty string/,
    );
    expect(() => normalizeMcpRouteOptions({ options: { ...base, ability: 7 }, route })).toThrow(
      /must be a string/,
    );
    expect(() => normalizeMcpRouteOptions({ options: { ...base, enabled: 'yes' }, route })).toThrow(
      /boolean or a function/,
    );
  });

  it('refuses anything that is not an options object', () => {
    expect(() => normalizeMcpRouteOptions({ options: undefined, route })).toThrow(
      /takes an options object/,
    );
  });

  it('carries only the keys that were given, so nothing is defaulted on the way through', () => {
    expect(
      normalizeMcpRouteOptions({ options: { kind: 'action', description: 'Cancel.' }, route }),
    ).toEqual({ kind: 'action', description: 'Cancel.' });
  });
});
