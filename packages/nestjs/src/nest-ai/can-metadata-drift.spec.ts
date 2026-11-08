import { CanAnyone, readCanDeclarations, staticCanArgs } from '@dudousxd/nestjs-agent-core';
import { Can, Policy } from '@nestjs/authorization';
import { describe, expect, it } from 'vitest';

/**
 * `@dudousxd/nestjs-agent-core` reads `@nestjs/authorization`'s metadata by its string keys
 * (`authorization:can`, `authorization:can-anyone`), which that package does not export. These
 * specs apply the real decorators, so a renamed key or a changed entry shape fails here instead of
 * silently offering ability-gated tools to everyone.
 */

interface User {
  id: string;
  roles?: string[];
}

@Policy()
class DriftPolicy {
  purge(user: User | null) {
    return user !== null;
  }
  has(user: User | null, role: string) {
    return user?.roles?.includes(role) === true;
  }
}

describe("@nestjs/authorization's metadata, as the agent reads it", () => {
  it('reads the real @Can() off a class and a method, args or not', () => {
    @Can(DriftPolicy, 'purge')
    class Tool {
      @Can(DriftPolicy, 'has', staticCanArgs('OPS'))
      @Can(DriftPolicy, 'has', (context) => [String(context.getType())])
      execute() {}
    }

    expect(readCanDeclarations(Tool, Tool.prototype.execute)).toEqual({
      requirements: [
        { policy: DriftPolicy, ability: 'purge' },
        { policy: DriftPolicy, ability: 'has', args: ['OPS'] },
      ],
      withArgs: 1,
    });
  });

  it('CanAnyone() writes what the real Can.Anyone() writes', () => {
    @Can.Anyone()
    class Real {}
    @CanAnyone()
    class Ours {}

    const keys = Reflect.getOwnMetadataKeys(Real);
    expect(keys.length).toBeGreaterThan(0);
    expect(Reflect.getOwnMetadataKeys(Ours)).toEqual(keys);
    for (const key of keys) {
      expect(Reflect.getOwnMetadata(key, Ours)).toEqual(Reflect.getOwnMetadata(key, Real));
    }
  });
});
