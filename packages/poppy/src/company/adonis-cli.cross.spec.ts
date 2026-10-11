import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentModule } from '@dudousxd/nestjs-agent';
import { InMemoryAgentStore, InMemoryPoppyStore } from '@dudousxd/nestjs-agent-core';
import { FakeModelProvider } from '@dudousxd/nestjs-agent-testing';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeCompany } from '../client/testing/fake-company.spec-helper.js';
import { freePort } from '../connections/connections.spec-helper.js';
import { AgentPoppyModule } from './agent-poppy.module.js';
import type { PoppyAuthenticate } from './auth.js';

/**
 * Interop across frameworks: the PUBLISHED Adonis reference Personal Agent (`poppy-agent` from
 * `@adonis-agora/agent`) talks to THIS package's conversation endpoint. The fake Company plays the
 * authorization server (discovery, sign-in, Session Tokens with DPoP); its `poppy.json` lists the
 * Nest endpoint, and the Nest app verifies the Session Token against the fake — DPoP proof
 * included, so a wrong public URL (`htu`) is a violation.
 *
^ * Opt-in (it downloads a package): `POPPY_ADONIS_CLI=npx` resolves
 * `poppy-agent` from `npx -p @adonis-agora/agent@<POPPY_ADONIS_VERSION, default 0.77.1>`; any other
 * value is the path of an installed `poppy-agent` binary.
 */
const cli = process.env.POPPY_ADONIS_CLI;
const version = process.env.POPPY_ADONIS_VERSION ?? '0.77.1';

/** The binary itself: under `npx`, resolved once in npx's cache, so children are the CLI's own. */
let bin = cli as string;
async function resolveBin(): Promise<void> {
  if (cli !== 'npx') return;
  const found = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      'npx',
      ['-y', '-p', `@adonis-agora/agent@${version}`, '-c', 'command -v poppy-agent'],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let out = '';
    child.stdout.on('data', (d) => {
      out += String(d);
    });
    child.on('close', (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`npx exited ${code}`)),
    );
  });
  bin = found;
}

function command(args: string[]): [string, string[]] {
  return [bin, args];
}

function run(args: string[], input?: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const [bin, argv] = command(args);
    const child = spawn(bin, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += String(d);
    });
    child.stderr.on('data', (d) => {
      out += String(d);
    });
    if (input !== undefined) child.stdin.end(input);
    child.on('close', (code) => resolve({ code, out }));
  });
}

class CompanyWithNestConversations extends FakeCompany {
  conversationsEndpoint = '';
  override poppyJson() {
    const doc = super.poppyJson() as ReturnType<FakeCompany['poppyJson']> & {
      agent: { protocols: { type: string; endpoint: string }[] };
    };
    return {
      ...doc,
      agent: { protocols: [{ type: 'poppy', endpoint: this.conversationsEndpoint }] },
    };
  }
}

describe.skipIf(!cli)('the published Adonis poppy-agent CLI against the Nest endpoint', () => {
  let company: CompanyWithNestConversations;
  let nest: INestApplication;
  let identity: ChildProcess | undefined;
  let dir: string;
  const verified: { method: string; url: string }[] = [];

  beforeAll(async () => {
    await resolveBin();
    company = await new CompanyWithNestConversations().start();
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    company.conversationsEndpoint = `${base}/poppy/conversations`;

    // The Session Token resolver an authorization server would install: the fake's token, its
    // DPoP proof checked against the PUBLIC url the Nest endpoint computed.
    const authenticate: PoppyAuthenticate = async (request) => {
      verified.push({ method: request.method, url: request.url });
      const [scheme, token] = String(request.headers.authorization ?? '').split(' ');
      const t = token === undefined ? undefined : company.tokens.get(token);
      if (scheme !== 'DPoP' || t === undefined) {
        return {
          ok: false,
          status: 401,
          error: 'invalid_token',
          wwwAuthenticate: 'DPoP error="invalid_token"',
        };
      }
      const dpop = (
        company as unknown as {
          dpop(req: IncomingMessage, url: string, token: string): Promise<{ error?: string }>;
        }
      ).dpop(
        { method: request.method, headers: request.headers } as unknown as IncomingMessage,
        request.url,
        token as string,
      );
      if ((await dpop).error) {
        return {
          ok: false,
          status: 401,
          error: 'invalid_dpop_proof',
          wwwAuthenticate: 'DPoP error="invalid_dpop_proof"',
        };
      }
      const signedIn = t.signedIn && company.sessions.get(t.sessionId)?.account !== undefined;
      return {
        ok: true,
        principal: {
          clientId: t.clientId,
          userId: t.userId,
          sessionId: t.sessionId,
          accountId: signedIn ? 'acct-1' : null,
          signedIn,
          scopes: signedIn ? t.scope.split(' ').filter(Boolean) : [],
        },
      };
    };

    const module = await Test.createTestingModule({
      imports: [
        AgentModule.forRoot({
          model: new FakeModelProvider(() => ({ text: 'Hello from the Nest company agent.' })),
          store: new InMemoryAgentStore(),
          actorResolver: { resolve: () => ({ id: 'nobody' }) },
        }),
        AgentPoppyModule.forRoot({
          baseUrl: base,
          authenticate,
          store: new InMemoryPoppyStore(),
        }),
      ],
    }).compile();
    nest = module.createNestApplication({ logger: false });
    await nest.listen(port, '127.0.0.1');

    // The CLI's own identity (agent.json + JWKS), served by the CLI — the fake fetches it.
    dir = await mkdtemp(join(tmpdir(), 'poppy-cross-'));
    const idPort = await freePort();
    const state = ['--state', join(dir, 'state.json'), '--insecure-dev'];
    const init = await run([
      'init',
      '--base-url',
      `http://127.0.0.1:${idPort}`,
      '--name',
      'Cross Test Agent',
      ...state,
    ]);
    expect(init.code, init.out).toBe(0);
    const [bin, argv] = command(['serve-identity', ...state]);
    identity = spawn(bin, argv, { stdio: 'ignore' });
    const deadline = Date.now() + 60_000;
    for (;;) {
      const ok = await fetch(`http://127.0.0.1:${idPort}/agent.json`).then(
        (r) => r.ok,
        () => false,
      );
      if (ok) break;
      if (Date.now() > deadline) throw new Error('the CLI never served its identity');
      await new Promise((r) => setTimeout(r, 200));
    }
  }, 180_000);

  afterAll(async () => {
    identity?.kill();
    await nest?.close();
    await company?.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it.each([
    ['events read (--no-stream)', ['--no-stream']],
    ['SSE stream', []],
  ])(
    'chats over %s: the Adonis client starts a conversation and reads the Nest agent’s reply',
    async (_how, mode) => {
      const state = ['--state', join(dir, 'state.json'), '--insecure-dev'];
      const domain = new URL(company.origin).host;
      // A message; stdin stays open until the reply is printed (closing it ends the chat).
      const chat = await new Promise<string>((resolve) => {
        const [bin, argv] = command(['chat', domain, ...mode, ...state]);
        const child = spawn(bin, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        const timer = setTimeout(() => child.kill(), 30_000);
        const read = (d: unknown) => {
          out += String(d);
          if (out.includes('Hello from the Nest company agent.')) child.kill();
        };
        child.stdout.on('data', read);
        child.stderr.on('data', read);
        child.on('close', () => {
          clearTimeout(timer);
          resolve(out);
        });
        child.stdin.write('Hi from the Adonis CLI\n');
      });
      expect(chat, chat).toMatch(/company\[agent\]: Hello from the Nest company agent\./);
      expect(verified.length).toBeGreaterThan(0);
      expect(verified.every((v) => v.url.startsWith(company.conversationsEndpoint))).toBe(true);
      expect(company.violations).toEqual([]);
    },
    120_000,
  );
});
