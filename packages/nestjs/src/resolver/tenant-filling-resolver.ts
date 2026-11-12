import {
  type Actor,
  type ActorResolver,
  type TenancyOption,
  readTenancy,
  withContextTenant,
} from '@dudousxd/nestjs-agent-core';

/**
 * `resolver`, with the context tenant filled into each actor it resolves without a `tenantRef`
 * while tenancy is on (read per request, so the context's switch is followed live). A `tenantRef`
 * the resolver sets wins. With `tenancy: false` the resolver is returned as is.
 *
 * The wrapper inherits from `resolver` (only `resolve` is its own), so `instanceof` and the
 * resolver's other members still read through.
 */
export function tenantFillingResolver(
  resolver: ActorResolver,
  tenancy: TenancyOption | undefined,
  contextAccessor: unknown,
): ActorResolver {
  if (tenancy === false) return resolver;
  const wrapper = Object.create(resolver) as ActorResolver;
  Object.defineProperty(wrapper, 'resolve', {
    value: async (req: unknown): Promise<Actor> =>
      withContextTenant(
        await resolver.resolve(req),
        readTenancy(tenancy ?? 'inherit', contextAccessor ?? undefined),
      ),
    enumerable: false,
  });
  return wrapper;
}
