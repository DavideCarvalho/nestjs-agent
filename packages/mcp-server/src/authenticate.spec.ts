import type { Actor, ActorResolver } from '@dudousxd/nestjs-agent-core';
import { ForbiddenException, HttpException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { authenticateMcpRequest } from './authenticate.js';

function resolverReturning(actor: Actor): ActorResolver {
  return { resolve: () => actor };
}

function resolverThrowing(error: unknown): ActorResolver {
  return {
    resolve: () => {
      throw error;
    },
  };
}

/** The HTTP status one authentication attempt is refused with, or 0 when it succeeded. */
async function statusOf(auth: ActorResolver): Promise<number> {
  try {
    await authenticateMcpRequest({ auth, request: {} });
  } catch (error) {
    if (error instanceof HttpException) {
      return error.getStatus();
    }
    throw error;
  }
  return 0;
}

describe('authenticateMcpRequest', () => {
  it('returns the actor the host resolver produced', async () => {
    const actor: Actor = { id: 'ci', roles: ['ANALYST'] };
    await expect(
      authenticateMcpRequest({ auth: resolverReturning(actor), request: {} }),
    ).resolves.toEqual(actor);
  });

  it('answers an unidentified caller with 401, never a 500', async () => {
    // A plain Error escaping a resolver reaches the client as "Internal server error" with a logged
    // stack: it misreports the request and makes every anonymous probe look like a server fault.
    const auth = resolverThrowing(new Error('no bearer token'));
    await expect(authenticateMcpRequest({ auth, request: {} })).rejects.toThrow(
      UnauthorizedException,
    );
    expect(await statusOf(auth)).toBe(401);
  });

  it('keeps the status a resolver chose for itself', async () => {
    expect(await statusOf(resolverThrowing(new ForbiddenException('key revoked')))).toBe(403);
  });

  it('rejects an actor that identifies nobody rather than passing it to the roles policy', async () => {
    expect(await statusOf(resolverReturning({ id: '' }))).toBe(401);
  });

  it('surfaces the resolver error message so a caller can tell what was wrong', async () => {
    const auth = resolverThrowing(new Error('unknown API key'));
    await expect(authenticateMcpRequest({ auth, request: {} })).rejects.toThrow(/unknown API key/);
  });
});
