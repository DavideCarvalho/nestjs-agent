import { All, Body, Controller, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  ROUTE_PARAM,
  joinRoutePath,
  pathParamNames,
  readNestRoute,
  readRouteMethod,
  readRouteParams,
  readRoutePath,
} from './nest-route-metadata.js';

class OrderDto {
  total = 0;
}

@Controller('orders')
class OrdersController {
  @Get(':id/lines/:lineId')
  findLine(
    @Param('id') _id: string,
    @Param('lineId') _lineId: string,
    @Query('expand') _expand: string,
  ): string {
    return 'line';
  }

  @Post()
  create(@Body() _order: OrderDto, @Query() _options: object, @Req() _request: object): string {
    return 'created';
  }

  @Get('raw')
  raw(@Res() _response: object): string {
    return 'raw';
  }

  @All('any')
  any(): string {
    return 'any';
  }

  notARoute(): string {
    return 'nope';
  }
}

@Controller()
class RootController {
  @Get()
  index(): string {
    return 'root';
  }
}

function methodOf(controller: object, name: string): object {
  const handler: unknown = Reflect.get(controller, name);
  if (typeof handler !== 'function') {
    throw new Error(`${name} is not a method`);
  }
  return handler;
}

describe('joinRoutePath', () => {
  it('joins a prefix and a suffix into one leading-slash template', () => {
    expect(joinRoutePath({ prefix: 'orders', suffix: ':id' })).toBe('/orders/:id');
    expect(joinRoutePath({ prefix: '/orders/', suffix: '/:id/' })).toBe('/orders/:id');
    expect(joinRoutePath({ prefix: undefined, suffix: undefined })).toBe('/');
    expect(joinRoutePath({ prefix: '/', suffix: 'health' })).toBe('/health');
  });
});

describe('pathParamNames', () => {
  it('names every placeholder, in order', () => {
    expect(pathParamNames('/orders/:id/lines/:lineId')).toEqual(['id', 'lineId']);
    expect(pathParamNames('/orders')).toEqual([]);
  });
});

describe('readRouteMethod', () => {
  it('names the verb a handler answers', () => {
    expect(readRouteMethod(methodOf(OrdersController.prototype, 'findLine'))).toBe('GET');
    expect(readRouteMethod(methodOf(OrdersController.prototype, 'create'))).toBe('POST');
  });

  it('answers nothing for a method that is not a route', () => {
    expect(readRouteMethod(methodOf(OrdersController.prototype, 'notARoute'))).toBeUndefined();
  });

  it('answers nothing for @All(), which has no single verb a request could carry', () => {
    expect(readRouteMethod(methodOf(OrdersController.prototype, 'any'))).toBeUndefined();
  });
});

describe('readRoutePath', () => {
  it('puts the controller prefix in front of the handler path', () => {
    expect(
      readRoutePath({
        controller: OrdersController,
        handler: methodOf(OrdersController.prototype, 'findLine'),
      }),
    ).toBe('/orders/:id/lines/:lineId');
  });

  it('handles a controller and a handler that declare no path', () => {
    expect(
      readRoutePath({
        controller: RootController,
        handler: methodOf(RootController.prototype, 'index'),
      }),
    ).toBe('/');
  });
});

describe('readRouteParams', () => {
  it('reads each declaration with its slot, its key and its declared type', () => {
    expect(readRouteParams({ controller: OrdersController, methodName: 'findLine' })).toEqual([
      { slot: ROUTE_PARAM.param, index: 0, key: 'id', metatype: String },
      { slot: ROUTE_PARAM.param, index: 1, key: 'lineId', metatype: String },
      { slot: ROUTE_PARAM.query, index: 2, key: 'expand', metatype: String },
    ]);
  });

  it('reads a whole-object slot with no key, and keeps the DTO it was declared as', () => {
    expect(readRouteParams({ controller: OrdersController, methodName: 'create' })).toEqual([
      { slot: ROUTE_PARAM.body, index: 0, key: undefined, metatype: OrderDto },
      { slot: ROUTE_PARAM.query, index: 1, key: undefined, metatype: Object },
      { slot: ROUTE_PARAM.request, index: 2, key: undefined, metatype: Object },
    ]);
  });

  it('reports a @Res() slot, which is what lets the boot refuse it', () => {
    expect(readRouteParams({ controller: OrdersController, methodName: 'raw' })).toEqual([
      { slot: ROUTE_PARAM.response, index: 0, key: undefined, metatype: Object },
    ]);
  });

  it('answers an empty list for a method with no declarations', () => {
    expect(readRouteParams({ controller: OrdersController, methodName: 'notARoute' })).toEqual([]);
  });
});

describe('readNestRoute', () => {
  it('reads one route whole', () => {
    expect(
      readNestRoute({
        controller: OrdersController,
        handler: methodOf(OrdersController.prototype, 'findLine'),
        methodName: 'findLine',
      }),
    ).toEqual({
      method: 'GET',
      path: '/orders/:id/lines/:lineId',
      params: [
        { slot: ROUTE_PARAM.param, index: 0, key: 'id', metatype: String },
        { slot: ROUTE_PARAM.param, index: 1, key: 'lineId', metatype: String },
        { slot: ROUTE_PARAM.query, index: 2, key: 'expand', metatype: String },
      ],
    });
  });

  it('answers nothing for a method that is not a one-verb HTTP route', () => {
    expect(
      readNestRoute({
        controller: OrdersController,
        handler: methodOf(OrdersController.prototype, 'any'),
        methodName: 'any',
      }),
    ).toBeUndefined();
  });
});
