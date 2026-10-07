import 'reflect-metadata';
import { AiTool } from '@dudousxd/nestjs-agent';
import {
  type Actor,
  type ApprovalPolicy,
  type MemoryProvider,
  staticSkillProvider,
} from '@dudousxd/nestjs-agent-core';
import { Injectable } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { openCode } from './engine.js';
import {
  type Harness,
  bootEngine,
  eventually,
  frames,
  framesUntil,
  textOf,
} from './testing/harness.js';

const actor: Actor = { id: 'u1', roles: ['ADMIN'] };

@AiTool({ name: 'lookup', kind: 'read', description: 'look something up', input: z.object({}) })
@Injectable()
class LookupTool {
  async execute() {
    return { found: true };
  }
}

@AiTool({ name: 'send', kind: 'action', description: 'send it', input: z.object({}) })
@Injectable()
class SendTool {
  async execute() {
    return { sent: true };
  }
}

describe('openCode engine: the library seams', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.app.close();
    h = undefined;
  });

  it('asks only what the approval policy requires, with its approver and expiry', async () => {
    const policy: ApprovalPolicy = {
      requirementFor: (tool) =>
        tool.name.endsWith('send_email')
          ? { required: true, approver: 'manager', ttlMs: 40 }
          : { required: false, approver: 'requester' },
    };
    h = await bootEngine({
      engine: (host) => openCode({ host }),
      options: { approvalPolicy: policy },
      script: async (t) => {
        t.emit('permission.asked', { id: 'per_read', action: 'company.gmail__search' });
        await t.next('permission.reply');
        t.emit('permission.asked', { id: 'per_send', action: 'company.gmail__send_email' });
        const reply = await t.next('permission.reply');
        t.emit('session.text.delta', { delta: String(reply.args.decision) });
        t.succeed();
      },
    });
    const { runId } = await h.service.chat({ actor, message: 'go' });
    const fs = await frames(h.service, runId);

    // Not required: answered at once, no card.
    expect(h.fake.callsOf('permission.reply')[0]?.args).toMatchObject({
      requestID: 'per_read',
      decision: 'once',
    });
    expect(fs).toContainEqual(
      expect.objectContaining({ kind: 'approval-settled', id: 'per_read', decidedVia: 'policy' }),
    );
    // Required: a card for the manager, which lapses.
    const requested = fs.find((f) => f.kind === 'approval-requested');
    expect(requested).toMatchObject({ id: 'per_send', approver: 'manager' });
    expect(requested && 'expiresAt' in requested && requested.expiresAt).toBeTruthy();
    const expired = h.fake.callsOf('permission.reply')[1]?.args;
    expect(expired).toMatchObject({ requestID: 'per_send', decision: 'reject' });
    expect(String(expired?.message)).toContain('in time');
    expect(fs).toContainEqual(
      expect.objectContaining({ kind: 'approval-settled', id: 'per_send', status: 'expired' }),
    );
  });

  it('rewinds the OpenCode session on a regenerate', async () => {
    h = await bootEngine({ engine: (host) => openCode({ host }) });
    const first = await h.service.chat({ actor, message: 'draft it' });
    await frames(h.service, first.runId);
    const again = await h.service.chat({
      actor,
      message: 'draft it',
      threadId: first.threadId,
      regenerate: true,
    });
    await frames(h.service, again.runId);

    expect(h.fake.callsOf('session.revert.stage')[0]?.args).toMatchObject({
      sessionID: 'ses_1',
      messageID: 'msg_ses_1_1',
    });
    expect(h.fake.callsOf('session.revert.commit')).toHaveLength(1);
    const messages = (await h.store.getThread(first.threadId))?.messages ?? [];
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it("serves the module's tools over MCP: reads allowed, actions asked", async () => {
    h = await bootEngine({
      engine: (host) =>
        openCode({
          host,
          tools: {
            url: 'https://app.test/mcp',
            headers: (who) => ({ Authorization: `Bearer token-for-${who.id}` }),
          },
        }),
      providers: [LookupTool, SendTool],
    });
    const { runId } = await h.service.chat({ actor, message: 'hi' });
    await frames(h.service, runId);

    expect(h.fake.callsOf('mcp.add')[0]?.args).toEqual({
      server: 'aviary',
      location: { directory: '/work/u1' },
      config: {
        type: 'remote',
        url: 'https://app.test/mcp',
        headers: { Authorization: 'Bearer token-for-u1' },
        oauth: false,
      },
    });
    const rules = h.fake.callsOf('session.create')[0]?.args.permissions;
    expect(rules).toEqual(
      expect.arrayContaining([
        { action: 'aviary*', resource: '*', effect: 'allow' },
        { action: 'aviary.send', resource: '*', effect: 'ask' },
        { action: 'aviary_send', resource: '*', effect: 'ask' },
      ]),
    );
    // Reads ride the server-wide allow; the action's ask comes after it (last match wins).
    const list = rules as Array<{ action: string }>;
    expect(list.findIndex((r) => r.action === 'aviary*')).toBeLessThan(
      list.findIndex((r) => r.action === 'aviary.send'),
    );
    // The host's own rules come first: OpenCode's last matching rule wins.
    expect((rules as unknown[])[0]).toEqual({ action: '*', resource: '*', effect: 'deny' });
  });

  it("writes the module's skills where OpenCode finds them, and allows them", async () => {
    h = await bootEngine({
      engine: (host) => openCode({ host }),
      options: {
        skills: {
          provider: staticSkillProvider([
            {
              name: 'weekly-status',
              description: 'How to write the weekly status',
              scope: 'global',
              body: '1. Start with what shipped.',
            },
          ]),
        },
      },
    });
    const { runId } = await h.service.chat({ actor, message: 'hi' });
    await frames(h.service, runId);

    expect(h.fake.files.get('.opencode/skills/weekly-status/SKILL.md')).toBe(
      '---\nname: weekly-status\ndescription: "How to write the weekly status"\n---\n\n1. Start with what shipped.\n',
    );
    expect(h.fake.callsOf('session.create')[0]?.args.permissions).toContainEqual({
      action: 'skill',
      resource: 'weekly-status',
      effect: 'allow',
    });
  });

  it('puts what is on file about the actor in the session', async () => {
    const provider: MemoryProvider = {
      list: () => [
        {
          id: 'm1',
          key: 'email.tone',
          text: 'Prefers short emails',
          scope: 'actor:u1',
          origin: { author: 'human' },
          updatedAt: '2026-10-01T00:00:00.000Z',
        },
      ],
      forget: () => false,
    };
    h = await bootEngine({
      engine: (host) => openCode({ host }),
      options: { memory: { provider } },
    });
    const { runId } = await h.service.chat({ actor, message: 'hi' });
    await frames(h.service, runId);

    const memory = h.fake
      .callsOf('session.instructions.entry.put')
      .find((c) => c.args.key === 'aviary.memory');
    expect(String(memory?.args.value)).toContain('email.tone: Prefers short emails');
    expect(String(memory?.args.value)).not.toContain('remember');
  });

  it('finds a permission it never heard about once the session goes idle', async () => {
    const box: { h?: Harness } = {};
    h = await bootEngine({
      engine: (host) => openCode({ host }),
      script: async (t) => {
        box.h?.fake.emitUnheard({
          type: 'permission.asked',
          data: { id: 'per_lost', sessionID: t.sessionId, action: 'company.send' },
        });
        box.h?.fake.goIdle();
        await t.next('permission.reply');
        t.emit('session.text.delta', { delta: 'done' });
        t.succeed();
      },
    });
    box.h = h;
    const { runId } = await h.service.chat({ actor, message: 'go' });
    await framesUntil(h.service, runId, (f) => f.kind === 'approval-requested');
    await h.service.approve(actor, 'per_lost');
    const fs = await frames(h.service, runId);
    expect(textOf(fs)).toBe('done');
    await eventually(
      () => h?.fake.callsOf('permission.reply')[0]?.args.decision === 'once',
      'the lost permission was answered',
    );
  });
});
