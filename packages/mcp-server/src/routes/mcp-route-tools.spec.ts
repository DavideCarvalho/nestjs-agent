import { type Actor, ToolRegistry } from '@dudousxd/nestjs-agent-core';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { McpRouteRef } from './mcp-route-dispatcher.js';
import {
  type McpRouteTool,
  McpRouteToolNameCollisionError,
  assertRouteToolNamesAreFree,
  buildRouteTool,
  defaultRouteToolName,
  routeToolRef,
  snakeCase,
} from './mcp-route-tools.js';
import type { McpRouteOptions } from './mcp.decorator.js';
import type { NestRoute } from './nest-route-metadata.js';

const ACTOR: Actor = { id: 'u-1', roles: ['ANALYST'] };

const ROUTE: NestRoute = { method: 'GET', path: '/orders/:id', params: [] };

function refFor(name: string, handler: string): McpRouteRef {
  return { tool: name, method: 'GET', path: '/orders', handler };
}

function toolNamed(name: string, handler: string): McpRouteTool {
  return {
    route: refFor(name, handler),
    spec: { name, kind: 'read', description: 'x', inputSchema: z.object({}) },
    handler: { execute: async () => undefined },
  };
}

describe('snakeCase', () => {
  it('breaks words the way a tool name reads', () => {
    expect(snakeCase('findOne')).toBe('find_one');
    expect(snakeCase('listForOrder')).toBe('list_for_order');
    expect(snakeCase('readHTTPLog')).toBe('read_http_log');
    expect(snakeCase('Orders')).toBe('orders');
  });
});

describe('defaultRouteToolName', () => {
  it('drops the Controller suffix and joins the two halves', () => {
    expect(
      defaultRouteToolName({ controllerName: 'OrdersController', methodName: 'findOne' }),
    ).toBe('orders_find_one');
    expect(
      defaultRouteToolName({ controllerName: 'OrderItemsController', methodName: 'listForOrder' }),
    ).toBe('order_items_list_for_order');
  });

  it('falls back to the method alone when the controller is called nothing else', () => {
    expect(defaultRouteToolName({ controllerName: 'Controller', methodName: 'health' })).toBe(
      'health',
    );
  });
});

describe('routeToolRef', () => {
  const options: McpRouteOptions = { kind: 'read', description: 'Read one order.' };

  it('derives the name, and names the handler a boot error would point at', () => {
    expect(
      routeToolRef({
        options,
        route: ROUTE,
        controllerName: 'OrdersController',
        methodName: 'findOne',
      }),
    ).toEqual({
      tool: 'orders_find_one',
      method: 'GET',
      path: '/orders/:id',
      handler: 'OrdersController.findOne',
    });
  });

  it('takes the name the author gave over the derived one', () => {
    expect(
      routeToolRef({
        options: { ...options, name: 'read_order' },
        route: ROUTE,
        controllerName: 'OrdersController',
        methodName: 'findOne',
      }).tool,
    ).toBe('read_order');
  });
});

describe('buildRouteTool', () => {
  it('produces an ordinary ToolSpec, carrying everything the gates read', () => {
    const { spec } = buildRouteTool({
      options: {
        kind: 'action',
        description: 'Cancel an order.',
        roles: ['OPS'],
        enabled: false,
        ability: 'orders.cancel',
      },
      route: ROUTE,
      ref: refFor('orders_cancel', 'OrdersController.cancel'),
      dispatch: async () => undefined,
    });
    expect(spec).toMatchObject({
      name: 'orders_cancel',
      kind: 'action',
      description: 'Cancel an order.',
      roles: ['OPS'],
      enabled: false,
      ability: 'orders.cancel',
    });
  });

  it('leaves roles, enabled and ability off when the route declared none, so the policy owns them', () => {
    const { spec } = buildRouteTool({
      options: { kind: 'read', description: 'Read one order.' },
      route: ROUTE,
      ref: refFor('orders_find_one', 'OrdersController.findOne'),
      dispatch: async () => undefined,
    });
    expect(Object.keys(spec).sort()).toEqual(['description', 'inputSchema', 'kind', 'name']);
  });

  it('dispatches with the actor the call authenticated as', async () => {
    const dispatch = vi.fn(async () => 'done');
    const { handler } = buildRouteTool({
      options: { kind: 'read', description: 'Read one order.' },
      route: ROUTE,
      ref: refFor('orders_find_one', 'OrdersController.findOne'),
      dispatch,
    });
    const args = { params: { id: '42' }, query: {}, body: undefined, hasBody: false };
    await handler.execute(args, {
      actor: ACTOR,
      threadId: 't',
      runId: 'r',
      requestId: 'q',
    });
    expect(dispatch).toHaveBeenCalledWith(args, ACTOR);
  });

  it('refuses to dispatch arguments its own schema did not produce', async () => {
    const dispatch = vi.fn(async () => 'done');
    const { handler } = buildRouteTool({
      options: { kind: 'read', description: 'Read one order.' },
      route: ROUTE,
      ref: refFor('orders_find_one', 'OrdersController.findOne'),
      dispatch,
    });
    await expect(
      handler.execute({ id: '42' }, { actor: ACTOR, threadId: 't', runId: 'r', requestId: 'q' }),
    ).rejects.toThrow(/its schema did not produce/);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('assertRouteToolNamesAreFree', () => {
  it('passes when every name answers for one thing', () => {
    expect(() =>
      assertRouteToolNamesAreFree({
        tools: [
          toolNamed('orders_find_one', 'OrdersController.findOne'),
          toolNamed('orders_list', 'OrdersController.list'),
        ],
        aiTools: new ToolRegistry(),
      }),
    ).not.toThrow();
  });

  it('names both routes when two claim one name', () => {
    let thrown: unknown;
    try {
      assertRouteToolNamesAreFree({
        tools: [
          toolNamed('orders_find_one', 'OrdersController.findOne'),
          toolNamed('orders_find_one', 'LegacyOrdersController.findOne'),
        ],
        aiTools: new ToolRegistry(),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(McpRouteToolNameCollisionError);
    expect(thrown).toMatchObject({ toolName: 'orders_find_one' });
    expect(String(thrown)).toMatch(/OrdersController\.findOne and LegacyOrdersController\.findOne/);
  });

  it('names both claimants when a route collides with an @AiTool', () => {
    // A registry resolves a duplicate by keeping the last writer, so a caller asking for the tool
    // they were shown would reach the other one, depending on module load order.
    const aiTools = new ToolRegistry();
    aiTools.register(
      { name: 'orders_find_one', kind: 'read', description: 'x', inputSchema: z.object({}) },
      { execute: async () => 'the @AiTool' },
    );
    expect(() =>
      assertRouteToolNamesAreFree({
        tools: [toolNamed('orders_find_one', 'OrdersController.findOne')],
        aiTools,
      }),
    ).toThrow(/the @AiTool of that name and the route OrdersController\.findOne/);
  });
});
