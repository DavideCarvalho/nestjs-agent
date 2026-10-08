import type { ActionProposal } from '@dudousxd/nestjs-agent-core';
import { describe, expect, it } from 'vitest';
import {
  type ScriptedFrame,
  actor,
  channel,
  fakeAdapter,
  fakeService,
  inbound,
  request,
  texts,
  until,
} from './channels.spec-helper.js';
import { type ChannelWebhookEvent, proposalButtonIds } from './handler.js';

const card = (proposalId: string, title = 'Refund order A-1?'): ScriptedFrame[] => [
  { kind: 'tool-input-start', id: `call-${proposalId}`, name: 'refund', toolKind: 'action' },
  {
    kind: 'approval-requested',
    id: `call-${proposalId}`,
    approver: 'requester',
    target: { kind: 'proposal', proposalId },
    confirmation: { title, verb: 'Refund' },
  },
];

/** A service whose proposals are listed and decided in memory. */
function proposalService(frames: ScriptedFrame[], pending: string[]) {
  const service = fakeService(frames, {
    listActionProposals: async () =>
      pending.map((id) => ({ id, decision: 'pending', execution: null })),
    decideActionProposal: async (...args: unknown[]) => {
      service.decided.push(args);
      return { proposalDecision: { status: 'applied' }, text: 'approved!' };
    },
  });
  return service;
}

// ── processing ──────────────────────────────────────────────────────────────────

describe('processing in this process (no durable engine)', () => {
  it('handles the messages of one conversation in order, one at a time', async () => {
    const { adapter, outbox } = fakeAdapter();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = fakeService((runId) =>
      (async function* () {
        if (runId === 'run-1') await gate;
        yield { kind: 'text', text: `answer to ${runId}` } as ScriptedFrame;
      })(),
    );
    const handler = channel(adapter, service);
    await handler.handle(request(inbound('first', { id: 'a1' })));
    await handler.handle(request(inbound('second', { id: 'a2' })));
    await handler.handle(request(inbound('elsewhere', { id: 'b1', conversation: 'chat-2' })));
    await until(() => outbox.length === 1);
    expect(service.sends.map((send) => send.message)).toEqual(['first', 'elsewhere']);
    release();
    await handler.drain();
    expect(outbox.map((item) => [item.conversation, item.message.text])).toEqual([
      ['chat-2', 'answer to run-2'],
      ['chat-1', 'answer to run-1'],
      ['chat-1', 'answer to run-3'],
    ]);
  });

  it('does not retry a refusal that retrying cannot change', async () => {
    const { adapter } = fakeAdapter();
    const errors: unknown[] = [];
    const refusal = Object.assign(new Error('quota used up'), { status: 429 });
    const service = fakeService([], {
      send: async () => {
        service.sends.push({});
        throw refusal;
      },
    });
    const handler = channel(adapter, service, {
      retry: { attempts: 3, backoffMs: 1 },
      onError: (error) => errors.push(error),
    });
    await handler.handle(request(inbound('hi')));
    await handler.drain();
    expect(service.sends).toHaveLength(1);
    expect(errors).toEqual([refusal]);
  });
});

// ── decisions scoped to the conversation ───────────────────────────────────────

describe('text decisions on a channel', () => {
  const delivered = `proposal-${'a'.repeat(40)}`;
  const elsewhere = `proposal-${'w'.repeat(40)}`;

  /** A conversation that was sent the card of `delivered`; `elsewhere` was proposed on the web. */
  async function conversation(
    pending: string[],
    options: { allowRemember?: boolean; card?: boolean } = {},
  ) {
    const { adapter, outbox } = fakeAdapter();
    const service = proposalService(
      [{ kind: 'text', text: 'Prepared.' }, ...(options.card === false ? [] : card(delivered))],
      pending,
    );
    const handler = channel(adapter, service, {
      outcomeTimeoutMs: 0,
      ...(options.allowRemember !== undefined ? { allowRemember: options.allowRemember } : {}),
    });
    await handler.handle(request(inbound('refund')));
    await handler.drain();
    outbox.length = 0;
    const say = async (text: string) => {
      await handler.handle(request(inbound(text)));
      await handler.drain();
    };
    return { service, outbox, say };
  }

  it('decides the one card delivered to this conversation', async () => {
    const { service, outbox, say } = await conversation([delivered, elsewhere]);
    await say('yes');
    expect(service.decided).toEqual([
      [actor, 't', delivered, { decision: 'approved', via: 'test' }],
    ]);
    expect(texts(outbox)).toEqual(['approved!']);
    expect(service.sends).toHaveLength(1);
  });

  it('never decides a proposal whose card was not delivered here', async () => {
    const { service, outbox, say } = await conversation([elsewhere], { card: false });
    await say('yes');
    await say(`no #${elsewhere}`);
    expect(service.decided).toEqual([]);
    expect(texts(outbox)).toEqual([
      'There is nothing waiting for your confirmation here.',
      'There is nothing waiting for your confirmation here.',
    ]);
    // Neither became a turn (the agent's own text decisions would have decided it).
    expect(service.sends).toHaveLength(1);
  });

  it('decides by #ID only among this conversation’s cards', async () => {
    const { service, say } = await conversation([delivered, elsewhere]);
    await say(`no #${delivered}`);
    expect(service.decided).toEqual([
      [actor, 't', delivered, { decision: 'rejected', via: 'test' }],
    ]);
  });

  it('reads "yes" as a message when nothing is pending, and starts turns without text decisions', async () => {
    const { adapter } = fakeAdapter();
    const calls: unknown[] = [];
    const service = proposalService([{ kind: 'text', text: 'ok' }], []);
    const send = service.send;
    service.send = (async (params: never, options: never) => {
      calls.push(options);
      return send(params, options);
    }) as never;
    const handler = channel(adapter, service);
    await handler.handle(request(inbound('yes')));
    await handler.drain();
    expect(service.sends.map((sent) => sent.message)).toEqual(['yes']);
    expect(calls).toEqual([{ textDecisions: false }]);
  });

  it('refuses "always in this conversation" where allowRemember is false', async () => {
    const strict = await conversation([delivered], { allowRemember: false });
    await strict.say('yes always in this conversation');
    expect(strict.service.decided).toEqual([]);
    expect(texts(strict.outbox)).toEqual([
      'Here every action needs its own confirmation. Reply without "always".',
    ]);
    const lenient = await conversation([delivered]);
    await lenient.say('yes always in this conversation');
    expect(lenient.service.decided).toEqual([
      [actor, 't', delivered, { decision: 'approved', remember: true, via: 'test' }],
    ]);
  });
});

// ── hooks ─────────────────────────────────────────────────────────────────────

describe('channel hooks', () => {
  it('unknownSender answers a sender actor() does not know — text, raw text and a file', async () => {
    const { adapter, outbox } = fakeAdapter({ media: true });
    const service = fakeService([]);
    const handler = channel(adapter, service, {
      actor: () => null,
      unknownSender: (message, context) => [
        `Hi **${message.from}**, link your number first.`,
        { text: 'https://app.example.com/link?a=*b*', raw: true },
        {
          media: { kind: 'image', url: 'https://cdn.example.com/qr.png', contentType: 'image/png' },
          caption: `Scan it on **${context.channel}**`,
        },
      ],
    });
    await handler.handle(request(inbound('hi')));
    await handler.drain();
    expect(outbox.map((item) => item.message)).toEqual([
      { text: 'Hi *5511999990000*, link your number first.' },
      { text: 'https://app.example.com/link?a=*b*' },
      {
        text: 'Scan it on *test*',
        media: { kind: 'image', url: 'https://cdn.example.com/qr.png', contentType: 'image/png' },
      },
    ]);
    expect(service.sends).toEqual([]);
  });

  it('beforeTurn gates every message: continue, a reply, or a silent stop', async () => {
    const { adapter, outbox } = fakeAdapter();
    const service = fakeService([{ kind: 'text', text: 'turn' }]);
    const handler = channel(adapter, service, {
      beforeTurn: (message) =>
        message.text === 'terms'
          ? { replies: ['Please accept the terms.', 'Reply *ACCEPT*.'] }
          : message.text === 'quiet'
            ? 'stop'
            : 'continue',
    });
    for (const text of ['terms', 'quiet', 'hello']) {
      await handler.handle(request(inbound(text)));
      await handler.drain();
    }
    expect(texts(outbox)).toEqual(['Please accept the terms.', 'Reply *ACCEPT*.', 'turn']);
    expect(service.sends.map((send) => send.message)).toEqual(['hello']);
  });

  it('canDeliver is asked before every outgoing message, and drops what it refuses', async () => {
    const { adapter, outbox } = fakeAdapter({ buttons: 3 });
    let linked = true;
    const asked: string[] = [];
    const service = fakeService(async function* () {
      yield { kind: 'text', text: 'Prepared.' } as ScriptedFrame;
      // The number is unlinked from the account while the turn runs.
      linked = false;
      yield* card('proposal-1');
    });
    const handler = channel(adapter, service, {
      canDeliver: (delivery) => {
        asked.push(`${delivery.kind}:${delivery.actor?.id}:${delivery.message?.text}`);
        return linked;
      },
    });
    await handler.handle(request(inbound('refund')));
    await handler.drain();
    expect(outbox).toEqual([]);
    expect(asked).toEqual(['reply:u1:refund', 'card:u1:refund']);
  });

  it('texts as a function speak each actor’s language', async () => {
    const { adapter, outbox } = fakeAdapter();
    const service = fakeService([{ kind: 'fail', code: 'run_failed', message: 'boom' }]);
    const handler = channel(adapter, service, {
      actor: (message) => (message.from === 'es' ? { id: 'es', roles: [] } : actor),
      texts: ({ actor: who }) => (who?.id === 'es' ? { failed: 'Lo siento, algo salió mal.' } : {}),
    });
    await handler.handle(request(inbound('hola', { from: 'es', conversation: 'es' })));
    await handler.handle(request(inbound('hi')));
    await handler.drain();
    expect(outbox.map((item) => [item.conversation, item.message.text])).toEqual([
      ['es', 'Lo siento, algo salió mal.'],
      ['chat-1', 'Sorry, something went wrong. Please try again.'],
    ]);
  });

  it('onTurnStarted sees the turn', async () => {
    const { adapter } = fakeAdapter();
    const started: unknown[] = [];
    const handler = channel(adapter, fakeService([{ kind: 'text', text: 'ok' }]), {
      thread: () => null,
      onTurnStarted: ({ runId, threadId, actor: who, message, queued }) => {
        started.push({ runId, threadId, actor: who.id, message: message.text, queued });
      },
    });
    await handler.handle(request(inbound('hi')));
    await handler.drain();
    expect(started).toEqual([
      { runId: 'run-1', threadId: 'thread-new', actor: 'u1', message: 'hi', queued: false },
    ]);
  });

  it('onWebhook tells what each request came to, without the content', async () => {
    const { adapter } = fakeAdapter();
    adapter.parse = (body) => ((body as { skip?: boolean }).skip ? null : (body as never));
    adapter.ignored = () => ({ reason: 'own message', event: 'messages.upsert' });
    const events: Omit<ChannelWebhookEvent, 'messages'>[] = [];
    const handler = channel(adapter, fakeService([]), {
      actor: () => null,
      onWebhook: ({ messages: _messages, ...event }) => {
        events.push(event);
      },
    });
    const message = inbound('hi', { id: 'same' });
    await handler.handle(request(message));
    await handler.handle(request(message));
    await handler.handle(request({ skip: true }));
    await handler.handle(request(message, { headers: { 'x-ok': '0' } }));
    await handler.handle(request(message, { method: 'GET' }));
    await handler.drain();
    expect(events).toEqual([
      { channel: 'test', status: 'accepted', accepted: 1, duplicates: 0 },
      { channel: 'test', status: 'duplicate', accepted: 0, duplicates: 1 },
      {
        channel: 'test',
        status: 'ignored',
        reason: 'own message',
        event: 'messages.upsert',
        accepted: 0,
        duplicates: 0,
      },
      { channel: 'test', status: 'unauthorized', accepted: 0, duplicates: 0 },
      { channel: 'test', status: 'method_not_allowed', accepted: 0, duplicates: 0 },
    ]);
  });

  it('renderComponent sends components as files before the text — replaced by id, none on failure', async () => {
    const chart = (id: string, points: number): ScriptedFrame => ({
      kind: 'ui',
      id,
      component: 'Chart',
      props: { points },
      fallbackText: `chart ${id}`,
    });
    const run = (frames: ScriptedFrame[]) => {
      const { adapter, outbox } = fakeAdapter({ media: true });
      const handler = channel(adapter, fakeService(frames), {
        uiCapabilities: { components: [{ name: 'Chart', versions: [1] }] } as never,
        renderComponent: (component) =>
          component.name === 'Chart'
            ? {
                media: {
                  kind: 'image',
                  url: `https://img.example.com/${component.id}/${(component.data as { points: number }).points}.png`,
                },
              }
            : null,
        texts: { componentsOnly: () => 'Here is the chart.' },
      });
      return { handler, outbox };
    };
    const ok = run([
      chart('c1', 1),
      { kind: 'ui', id: 't1', component: 'Table', props: {}, fallbackText: 'a | b' },
      { kind: 'text', text: 'Your weight is up.' },
      chart('c1', 2),
    ]);
    await ok.handler.handle(request(inbound('chart')));
    await ok.handler.drain();
    expect(ok.outbox.map((item) => item.message)).toEqual([
      { text: '', media: { kind: 'image', url: 'https://img.example.com/c1/2.png' } },
      { text: 'a | b\n\nYour weight is up.' },
    ]);

    const only = run([chart('c1', 1)]);
    await only.handler.handle(request(inbound('chart')));
    await only.handler.drain();
    expect(texts(only.outbox)).toEqual(['', 'Here is the chart.']);

    const failed = run([chart('c1', 1), { kind: 'fail', code: 'run_failed', message: 'x' }]);
    await failed.handler.handle(request(inbound('chart')));
    await failed.handler.drain();
    expect(texts(failed.outbox)).toEqual(['Sorry, something went wrong. Please try again.']);
  });

  it('a file reply on a channel without files sends its fallback text', async () => {
    const { adapter, outbox } = fakeAdapter();
    const handler = channel(adapter, fakeService([]), {
      actor: () => null,
      unknownSender: () => ({
        media: { kind: 'document', url: 'https://x/terms.pdf' },
        caption: 'Terms',
        fallbackText: 'Terms: https://x/terms.pdf',
      }),
    });
    await handler.handle(request(inbound('hi')));
    await handler.drain();
    expect(texts(outbox)).toEqual(['Terms: https://x/terms.pdf']);
  });

  it('prepareMedia reads a voice note as text, mediaLimits lets it through, transformInbound adds a note', async () => {
    const { adapter, outbox } = fakeAdapter();
    adapter.download = async (media) => ({
      data: Buffer.from('ogg'),
      contentType: media.contentType ?? 'application/octet-stream',
    });
    const staged: string[] = [];
    const limits = {
      enabled: true,
      upload: 'direct',
      maxBytes: 1000,
      allowedContentTypes: ['image/png'],
      maxPerMessage: 10,
    };
    const service = fakeService([{ kind: 'text', text: 'Noted.' }], {
      attachmentLimits: () => limits,
      stageAttachment: async (_actor: unknown, file: { contentType: string }) => {
        staged.push(file.contentType);
        return { mediaId: `media-${staged.length}`, url: '', contentType: file.contentType };
      },
    });
    const handler = channel(adapter, service, {
      mediaLimits: (base, media) =>
        media.kind === 'audio' && base
          ? { ...base, allowedContentTypes: [...base.allowedContentTypes, 'audio/ogg'] }
          : base,
      prepareMedia: (file, media) =>
        media.kind === 'audio' ? { text: `(voice) ${file.data.toString()}` } : undefined,
      transformInbound: (message) => ({
        ...message,
        text:
          message.attachments.length > 0
            ? `${message.text || 'What is in this image?'}\n\n[attachments: ${message.attachments.map((a) => a.mediaId).join(', ')}]`
            : message.text,
      }),
    });
    await handler.handle(
      request(
        inbound('', { id: 'v1', media: [{ kind: 'audio', contentType: 'audio/ogg', ref: 'a' }] }),
      ),
    );
    await handler.handle(
      request(
        inbound('', { id: 'i1', media: [{ kind: 'image', contentType: 'image/png', ref: 'i' }] }),
      ),
    );
    await handler.drain();
    expect(staged).toEqual(['image/png']);
    expect(service.sends.map((send) => send.message)).toEqual([
      '(voice) ogg',
      'What is in this image?\n\n[attachments: media-1]',
    ]);
    expect(service.sends[1].attachments).toEqual([{ mediaId: 'media-1' }]);
    expect(texts(outbox)).toEqual(['Noted.', 'Noted.']);
  });

  it('formatOutcome relays the outcome and a follow-up sent alone and raw — once, in order', async () => {
    const { adapter, outbox } = fakeAdapter();
    const handler = channel(adapter, fakeService([]), {
      formatOutcome: (proposal, { text }) => {
        const forward = (proposal.execution as { result?: { forward?: string } } | null)?.result
          ?.forward;
        return forward === undefined
          ? null
          : [`${text} Forward the message below:`, { text: forward, raw: true }];
      },
    });
    const proposal = {
      id: 'p-share',
      toolName: 'share_with_doctor',
      decision: 'approved',
      actorRef: 'u1',
      execution: { status: 'succeeded', result: { forward: 'Open *this*: https://x/y' } },
    } as unknown as ActionProposal;
    expect(await handler.relayOutcome(proposal, 'chat-9')).toBe(true);
    expect(await handler.relayOutcome(proposal, 'chat-9')).toBe(false);
    expect(outbox.map((item) => [item.conversation, item.message.text])).toEqual([
      ['chat-9', 'Done. Forward the message below:'],
      ['chat-9', 'Open *this*: https://x/y'],
    ]);
    // An outcome is checked by canDeliver too, as the proposal's actor.
    const { adapter: other, outbox: none } = fakeAdapter();
    const guarded = channel(other, fakeService([]), {
      canDeliver: (delivery) => delivery.actorRef !== 'u1' || delivery.kind !== 'outcome',
    });
    await guarded.relayOutcome({ ...proposal, id: 'p-2' } as ActionProposal, 'chat-9');
    expect(none).toEqual([]);
  });

  it('a card carries texts.footer: as the provider footer, and at the end of the text fallback', async () => {
    const { adapter, outbox } = fakeAdapter({ buttons: 3 });
    const handler = channel(adapter, fakeService(card('proposal-1')), {
      texts: { footer: 'Valid for **5 minutes**.' },
    });
    await handler.handle(request(inbound('refund')));
    await handler.drain();
    const ids = proposalButtonIds('proposal-1');
    expect(outbox[0]?.message).toEqual({
      text: '*Refund order A-1?*',
      buttons: [
        { id: ids.approve, label: 'Confirm' },
        { id: ids.reject, label: 'Cancel' },
      ],
      fallbackText:
        '*Refund order A-1?*\n\nReply *yes* to confirm or *no* to cancel.\n\nValid for *5 minutes*.',
      instruction: 'Reply *yes* to confirm or *no* to cancel.',
      footer: 'Valid for *5 minutes*.',
    });
  });
});
