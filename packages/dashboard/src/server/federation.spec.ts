import type { AgentGovernanceQueries } from '@dudousxd/nestjs-agent-core';
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { CONSOLE_APPS, normalizeConsoleResult } from './console-authorize.js';
import {
  type AgentConsoleFederation,
  assertValidFederation,
  currentFederatedApp,
  describeFederation,
  resolveFederatedApp,
  selectedAppName,
  withFederatedApp,
} from './federation.js';

const queries = {} as AgentGovernanceQueries;
const federation: AgentConsoleFederation = {
  apps: { a: { label: 'Orders', queries }, b: { queries } },
};

describe('selectedAppName', () => {
  it('reads the header first, then ?app=', () => {
    expect(selectedAppName({ headers: { 'x-agent-app': 'a' }, query: { app: 'b' } })).toBe('a');
    expect(selectedAppName({ headers: { 'x-agent-app': ['b', 'a'] } })).toBe('b');
    expect(selectedAppName({ headers: {}, query: { app: 'b' } })).toBe('b');
  });

  it('is undefined for none, an empty value or a non-string', () => {
    expect(selectedAppName(undefined)).toBeUndefined();
    expect(selectedAppName({ headers: { 'x-agent-app': '' }, query: { app: '' } })).toBeUndefined();
    expect(selectedAppName({ query: { app: ['a'] } })).toBeUndefined();
  });
});

describe('resolveFederatedApp', () => {
  it('is undefined without federation or without a selection', () => {
    expect(resolveFederatedApp(null, { query: { app: 'a' } })).toBeUndefined();
    expect(resolveFederatedApp(federation, { query: {} })).toBeUndefined();
  });

  it('resolves a configured app', () => {
    const scope = resolveFederatedApp(federation, { query: { app: 'b' } });
    expect(scope?.name).toBe('b');
    expect(scope?.app).toBe(federation.apps.b);
  });

  it('404s an unknown app, including inherited object keys', () => {
    expect(() => resolveFederatedApp(federation, { query: { app: 'z' } })).toThrow(
      NotFoundException,
    );
    expect(() => resolveFederatedApp(federation, { query: { app: 'toString' } })).toThrow(
      NotFoundException,
    );
  });

  it("404s an app outside the viewer's grant, like an unknown one", () => {
    const request = { query: { app: 'b' }, [CONSOLE_APPS]: ['a'] };
    expect(() => resolveFederatedApp(federation, request)).toThrow(NotFoundException);
    expect(resolveFederatedApp(federation, { ...request, query: { app: 'a' } })?.name).toBe('a');
  });
});

describe('describeFederation', () => {
  it('lists the granted apps with their labels', () => {
    expect(describeFederation(federation, undefined, undefined)).toEqual({
      local: { label: 'this app' },
      apps: [
        { name: 'a', label: 'Orders' },
        { name: 'b', label: 'b' },
      ],
    });
    expect(describeFederation({ ...federation, localLabel: 'Hub' }, ['b'], 'b')).toEqual({
      local: { label: 'Hub' },
      apps: [{ name: 'b', label: 'b' }],
      current: 'b',
    });
  });
});

describe('assertValidFederation', () => {
  it('accepts a valid federation and none', () => {
    expect(() => assertValidFederation(undefined)).not.toThrow();
    expect(() => assertValidFederation(federation)).not.toThrow();
  });

  it('refuses an empty name or a missing `queries`', () => {
    expect(() => assertValidFederation({ apps: { '': { queries } } })).toThrow(/non-empty/);
    expect(() => assertValidFederation({ apps: { x: {} as never } })).toThrow(/queries/);
    expect(() => assertValidFederation({ apps: null as never })).toThrow(/object/);
  });
});

describe('the federated scope', () => {
  it('holds the app across async continuations, and only inside', async () => {
    const scope = { name: 'a', app: { queries } };
    const seen = await withFederatedApp(scope, async () => {
      await Promise.resolve();
      return currentFederatedApp()?.name;
    });
    expect(seen).toBe('a');
    expect(currentFederatedApp()).toBeUndefined();
  });
});

describe('the `apps` grant', () => {
  it('rides an allow decision, strings only', () => {
    expect(normalizeConsoleResult({ allowed: true, apps: ['a', 3, 'b'] })).toEqual({
      allowed: true,
      apps: ['a', 'b'],
    });
    expect(normalizeConsoleResult({ allowed: true })).toEqual({ allowed: true });
    expect(normalizeConsoleResult({ allowed: false, apps: ['a'] })).toEqual({
      allowed: false,
      reason: 'forbidden',
    });
  });
});
