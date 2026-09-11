import type { StandardSchemaV1 } from '@standard-schema/spec';
import { describe, expect, it } from 'vitest';
import { toMcpInputSchema } from '../tool-json-schema.js';
import { type NestRoute, ROUTE_PARAM, type RouteParamDeclaration } from './nest-route-metadata.js';
import { routeInputSchema } from './route-input-schema.js';

class CreateOrderDto {
  total = 0;
}

function route(input: {
  path?: string;
  params?: Array<Partial<RouteParamDeclaration> & { slot: number }>;
}): NestRoute {
  return {
    method: 'GET',
    path: input.path ?? '/orders',
    params: (input.params ?? []).map((declaration, index) => ({
      slot: declaration.slot,
      index: declaration.index ?? index,
      key: declaration.key,
      metatype: declaration.metatype,
    })),
  };
}

function advertised(input: Parameters<typeof route>[0]): unknown {
  return toMcpInputSchema(routeInputSchema(route(input)));
}

function accepted(
  schema: StandardSchemaV1,
  value: unknown,
): StandardSchemaV1.Result<unknown> | Promise<StandardSchemaV1.Result<unknown>> {
  return schema['~standard'].validate(value);
}

async function issuesOf(schema: StandardSchemaV1, value: unknown): Promise<string> {
  const result = await accepted(schema, value);
  return (result.issues ?? []).map((entry) => entry.message).join('; ');
}

async function parsed(schema: StandardSchemaV1, value: unknown): Promise<unknown> {
  const result = await accepted(schema, value);
  if (result.issues !== undefined) {
    throw new Error(result.issues.map((entry) => entry.message).join('; '));
  }
  return result.value;
}

describe('routeInputSchema — what the route already declares', () => {
  it('takes path placeholders from a bare @Param(), and requires every one of them', () => {
    expect(
      advertised({
        path: '/orders/:id/lines/:lineId',
        params: [{ slot: ROUTE_PARAM.param, key: undefined, metatype: Object }],
      }),
    ).toEqual({
      type: 'object',
      properties: {
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, lineId: { type: 'string' } },
          required: ['id', 'lineId'],
          additionalProperties: false,
        },
      },
      required: ['params'],
      additionalProperties: false,
    });
  });

  it('names a placeholder once when both a bare and a keyed @Param() reach it', () => {
    // `required: ['id', 'id']` is a schema a strict client rejects.
    expect(
      advertised({
        path: '/orders/:id',
        params: [
          { slot: ROUTE_PARAM.param, key: undefined, metatype: Object },
          { slot: ROUTE_PARAM.param, key: 'id', metatype: String },
        ],
      }),
    ).toMatchObject({ properties: { params: { required: ['id'] } } });
  });

  it('takes only the placeholder a keyed @Param() named', () => {
    expect(
      advertised({
        path: '/orders/:id/lines/:lineId',
        params: [{ slot: ROUTE_PARAM.param, key: 'id', metatype: String }],
      }),
    ).toMatchObject({
      properties: {
        params: { properties: { id: { type: 'string' } }, required: ['id'] },
      },
    });
  });

  it('types a keyed @Query() from its declared type, and never requires one', () => {
    expect(
      advertised({
        params: [
          { slot: ROUTE_PARAM.query, key: 'status', metatype: String },
          { slot: ROUTE_PARAM.query, key: 'limit', metatype: Number },
          { slot: ROUTE_PARAM.query, key: 'archived', metatype: Boolean },
        ],
      }),
    ).toEqual({
      type: 'object',
      properties: {
        query: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            limit: { type: 'number' },
            archived: { type: 'boolean' },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    });
  });

  it('leaves a whole-object @Query() open, because its DTO has no fields at runtime', () => {
    expect(
      advertised({ params: [{ slot: ROUTE_PARAM.query, key: undefined, metatype: Object }] }),
    ).toMatchObject({
      properties: { query: { type: 'object', properties: {}, additionalProperties: true } },
    });
  });

  it('requires a keyed @Body() field, which is the whole body the route declared', () => {
    expect(
      advertised({ params: [{ slot: ROUTE_PARAM.body, key: 'term', metatype: String }] }),
    ).toEqual({
      type: 'object',
      properties: {
        body: {
          type: 'object',
          properties: { term: { type: 'string' } },
          required: ['term'],
          additionalProperties: false,
        },
      },
      required: ['body'],
      additionalProperties: false,
    });
  });

  it('names the DTO a whole-object @Body() was declared as, and leaves the slot open', () => {
    // The fields are erased by the time the app runs; only the constructor survives. The route's
    // own ValidationPipe still judges what arrives, so an open slot loses the model a hint and
    // nothing else.
    expect(
      advertised({
        params: [{ slot: ROUTE_PARAM.body, key: undefined, metatype: CreateOrderDto }],
      }),
    ).toMatchObject({
      properties: {
        body: {
          type: 'object',
          additionalProperties: true,
          description: 'A CreateOrderDto. Its fields are validated by the route itself.',
        },
      },
      required: ['body'],
    });
  });

  it('advertises an empty object for a route that declares nothing', () => {
    expect(advertised({})).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });

  it('ignores slots a caller does not fill, such as @Req()', () => {
    expect(
      advertised({ params: [{ slot: ROUTE_PARAM.request, key: undefined, metatype: Object }] }),
    ).toEqual({ type: 'object', properties: {}, additionalProperties: false });
  });
});

describe('routeInputSchema — what it accepts', () => {
  const schema = routeInputSchema(
    route({
      path: '/orders/:id',
      params: [
        { slot: ROUTE_PARAM.param, key: 'id', metatype: String },
        { slot: ROUTE_PARAM.query, key: 'limit', metatype: Number },
        { slot: ROUTE_PARAM.body, key: undefined, metatype: CreateOrderDto },
      ],
    }),
  );

  it('reduces path and query values to the text a request carries', () => {
    // A ParseIntPipe parses a string, because on the wire there is nothing else to parse.
    expect(
      parsed(schema, { params: { id: 42 }, query: { limit: 10 }, body: { total: 3 } }),
    ).resolves.toEqual({
      params: { id: '42' },
      query: { limit: '10' },
      body: { total: 3 },
      hasBody: true,
    });
  });

  it('refuses a key that is not a slot of the request, and says where arguments go', async () => {
    expect(await issuesOf(schema, { id: '42', body: {} })).toMatch(
      /"id" is not a slot of this request/,
    );
  });

  it('refuses a path placeholder the caller left out', async () => {
    expect(await issuesOf(schema, { body: {} })).toMatch(/"params.id" is required/);
  });

  it('refuses a body the route declared and the caller omitted', async () => {
    expect(await issuesOf(schema, { params: { id: '42' } })).toMatch(/"body" is required/);
  });

  it('refuses a params value that is not a scalar', async () => {
    expect(await issuesOf(schema, { params: { id: { nested: true } }, body: {} })).toMatch(
      /"params.id" must be a string, number or boolean/,
    );
  });

  it('refuses arguments that are not an object at all', async () => {
    expect(await issuesOf(schema, ['orders'])).toMatch(/must be an object with "params"/);
    expect(await issuesOf(schema, 'orders')).toMatch(/must be an object with "params"/);
  });

  it('accepts nothing at all for a route that declares nothing', () => {
    const bare = routeInputSchema(route({}));
    expect(parsed(bare, undefined)).resolves.toEqual({
      params: {},
      query: {},
      body: undefined,
      hasBody: false,
    });
  });
});
