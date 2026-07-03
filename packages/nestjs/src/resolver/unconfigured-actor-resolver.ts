import type { Actor, ActorResolver } from '@dudousxd/nestjs-agent-core';

/**
 * The default {@link ActorResolver} installed when `forRoot` is given no `actorResolver`.
 * It throws on every request rather than inventing an identity — security-by-default. Wire
 * a real resolver (or the opt-in `HeaderActorResolver`) via `forRoot({ actorResolver })`.
 */
export class UnconfiguredActorResolver implements ActorResolver {
  resolve(): Actor {
    throw new Error(
      'No actorResolver configured. AgentModule refuses to fabricate a caller identity. ' +
        'Pass AgentModule.forRoot({ actorResolver }) with a resolver that reads your ' +
        'authenticated principal, or the built-in HeaderActorResolver behind a trusted gateway.',
    );
  }
}
