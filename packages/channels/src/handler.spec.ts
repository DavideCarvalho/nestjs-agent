import {
  DEFAULT_TEXT_ACTION_PROPOSAL_VOCABULARY,
  parseTextActionProposalCommand,
  ptBrActionProposalText,
} from '@dudousxd/nestjs-agent-core';
import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { whatsmiau } from './adapters/whatsmiau.js';
import {
  type ScriptedFrame,
  actor,
  channel,
  fakeAdapter,
  fakeService,
  inbound,
  request,
  texts,
} from './channels.spec-helper.js';
import {
  DEFAULT_CHANNEL_TEXTS,
  channelTextsFor,
  proposalButtonIds,
  ptBrChannelTexts,
} from './handler.js';

describe('ChannelHandler — the route', () => {
  it('logs a webhook that carried no message — event and reason, never the content', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const debug = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    try {
      const handler = channel(
        whatsmiau({
          url: 'http://whatsmiau:8080',
          instance: 'main',
          apiKey: 'k',
          webhookToken: false,
        }),
        fakeService([]),
      );
      const upsert = (key: Record<string, unknown>, status: string) => ({
        event: 'messages.upsert',
        instance: 'main',
        data: { key, status, message: { conversation: 'secret text' } },
      });
      expect(
        await handler.handle(
          request(upsert({ remoteJid: '5511999990000@s.whatsapp.net', id: 'a' }, 'PENDING')),
        ),
      ).toEqual({ status: 200, body: { ok: true } });
      await handler.handle(
        request(
          upsert(
            { remoteJid: '5511999990000@s.whatsapp.net', id: 'b', fromMe: true },
            'SERVER_ACK',
          ),
        ),
      );
      await handler.handle(request({ event: 'connection.update', instance: 'main' }));
      expect(warn.mock.calls).toEqual([
        [
          'Webhook on "whatsapp" ignored (event messages.upsert): fromMe missing and status PENDING',
        ],
      ]);
      expect(debug.mock.calls).toEqual([
        ['Webhook on "whatsapp" ignored (event messages.upsert): own message'],
        ['Webhook on "whatsapp" ignored (event connection.update): not a messages.upsert event'],
      ]);
      expect(JSON.stringify([warn.mock.calls, debug.mock.calls])).not.toContain('secret');
    } finally {
      warn.mockRestore();
      debug.mockRestore();
    }
  });

  it('refuses an unverified request and acknowledges a verified one before the turn ends', async () => {
    const { adapter, outbox } = fakeAdapter();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = fakeService(async function* () {
      yield { kind: 'text', text: 'Hello ' };
      await gate;
      yield { kind: 'text', text: '**there**' };
    });
    const handler = channel(adapter, service, { thread: () => 'thread-1' });

    expect(
      (await handler.handle(request(inbound('hi'), { headers: { 'x-ok': '0' } }))).status,
    ).toBe(401);
    expect(await handler.handle(request(inbound('hi')))).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(outbox).toEqual([]);
    release();
    await handler.drain();
    expect(outbox).toEqual([{ conversation: 'chat-1', message: { text: 'Hello *there*' } }]);
    expect(service.sends[0]).toMatchObject({
      actor,
      threadId: 'thread-1',
      message: 'hi',
      uiCapabilities: { components: [] },
      pageContext: { kind: 'test', channel: { name: 'test', conversation: 'chat-1' } },
      hostContext: { channel: 'test', conversation: 'chat-1' },
    });
  });

  it('answers a GET it does not know with 405, and a provider challenge with its body', async () => {
    const { adapter } = fakeAdapter();
    const handler = channel(adapter, fakeService([]));
    expect((await handler.handle(request(null, { method: 'GET' }))).status).toBe(405);
    adapter.challenge = () => ({ status: 200, body: 'echo' });
    expect(await handler.handle(request(null, { method: 'GET' }))).toEqual({
      status: 200,
      body: 'echo',
      contentType: 'text/plain',
    });
  });

  it('answers a duplicate delivery once', async () => {
    const { adapter, outbox } = fakeAdapter();
    const service = fakeService([{ kind: 'text', text: 'once' }]);
    const handler = channel(adapter, service);
    const message = inbound('hi', { id: 'same' });
    await handler.handle(request(message));
    await handler.handle(request(message));
    await handler.drain();
    expect(service.sends).toHaveLength(1);
    expect(texts(outbox)).toEqual(['once']);
  });

  it('splits a long reply at the channel limit, keeping component fallback text in order', async () => {
    const { adapter, outbox } = fakeAdapter({ maxLength: 40 });
    const service = fakeService([
      { kind: 'text', text: 'First paragraph of the answer.' },
      {
        kind: 'ui',
        id: 'c1',
        component: 'OrderSummary',
        props: {},
        fallbackText: '*Order A-1* — paid',
      },
      { kind: 'text', text: 'And a closing sentence here.' },
    ]);
    const handler = channel(adapter, service);
    await handler.handle(request(inbound('hi')));
    await handler.drain();
    expect(texts(outbox)).toEqual([
      'First paragraph of the answer.',
      '*Order A-1* — paid',
      'And a closing sentence here.',
    ]);
  });

  it('never sends a preview of a tree the model is still writing: only the final text', async () => {
    const { adapter, outbox } = fakeAdapter();
    const preview = (title: string) => ({
      kind: 'ui' as const,
      id: 'call-0:ui:0',
      component: 'genui:tree',
      props: { root: { id: 'root', type: 'Card', props: { title }, incomplete: true } },
      toolCallId: 'call-0',
      partial: true as const,
    });
    const rendered: unknown[] = [];
    const service = fakeService([
      preview('Sal'),
      preview('Sales'),
      {
        kind: 'ui',
        id: 'call-0:ui:0',
        component: 'genui:tree',
        props: { root: { type: 'Card', props: { title: 'Sales' } } },
        toolCallId: 'call-0',
        fallbackText: '*Sales*',
      },
      { kind: 'text', text: 'There.' },
    ]);
    const handler = channel(adapter, service, {
      renderComponent: (component) => {
        rendered.push(component.data);
        return null;
      },
    });
    await handler.handle(request(inbound('dashboard')));
    await handler.drain();
    expect(rendered).toEqual([{ root: { type: 'Card', props: { title: 'Sales' } } }]);
    expect(texts(outbox)).toEqual(['*Sales*\n\nThere.']);
  });

  it('creates a thread for a new conversation and reports it', async () => {
    const { adapter } = fakeAdapter();
    const service = fakeService([{ kind: 'text', text: 'hi' }]);
    const created: string[] = [];
    const handler = channel(adapter, service, {
      thread: () => null,
      onThreadCreated: (threadId) => {
        created.push(threadId);
      },
    });
    await handler.handle(request(inbound('hi')));
    await handler.drain();
    expect(service.sends[0].threadId).toBeUndefined();
    expect(created).toEqual(['thread-new']);
  });

  it('does not answer an unknown sender — or says so when told to', async () => {
    const { adapter, outbox } = fakeAdapter();
    const service = fakeService([]);
    const silent = channel(adapter, service, { actor: () => null });
    await silent.handle(request(inbound('hi')));
    await silent.drain();
    expect(outbox).toEqual([]);
    const polite = channel(adapter, service, {
      actor: () => null,
      texts: { unknownSender: 'Link your account first.' },
    });
    await polite.handle(request(inbound('hi')));
    await polite.drain();
    expect(texts(outbox)).toEqual(['Link your account first.']);
    expect(service.sends).toEqual([]);
  });

  it('relays a text decision reply without starting a turn', async () => {
    const { adapter, outbox } = fakeAdapter();
    const service = fakeService([], {
      send: async () => ({
        threadId: 't',
        proposalDecision: { status: 'applied' },
        text: 'Proposal approved and queued to run.',
      }),
    });
    const handler = channel(adapter, service);
    await handler.handle(request(inbound('yes')));
    await handler.drain();
    expect(texts(outbox)).toEqual(['Proposal approved and queued to run.']);
    expect(service.subscribed).toEqual([]);
  });

  it('follows a queued message under its own id', async () => {
    const { adapter, outbox } = fakeAdapter();
    const service = fakeService([{ kind: 'text', text: 'later' }], {
      send: async () => ({
        threadId: 't',
        queued: true,
        messageId: 'queued-1',
        position: 0,
        queue: { items: [] },
      }),
    });
    const handler = channel(adapter, service);
    await handler.handle(request(inbound('second')));
    await handler.drain();
    expect(service.subscribed).toEqual(['queued-1']);
    expect(texts(outbox)).toEqual(['later']);
  });

  const proposalId = `proposal-${'a'.repeat(64)}`;
  const proposalFrames: ScriptedFrame[] = [
    { kind: 'text', text: 'I prepared the refund.' },
    { kind: 'tool-input-start', id: 'call-1', name: 'refund', toolKind: 'action' },
    {
      kind: 'approval-requested',
      id: 'call-1',
      approver: 'requester',
      target: { kind: 'proposal', proposalId },
      confirmation: { title: 'Refund order A-1?', verb: 'Refund', detail: 'Amount: 10.00' },
    },
  ];

  it('puts a pending proposal to the person with buttons where the channel has them', async () => {
    const { adapter, outbox } = fakeAdapter({ buttons: 3 });
    const handler = channel(adapter, fakeService(proposalFrames));
    await handler.handle(request(inbound('refund A-1')));
    await handler.drain();
    const ids = proposalButtonIds(proposalId);
    expect(outbox.map((item) => item.message)).toEqual([
      { text: 'I prepared the refund.' },
      {
        text: '*Refund order A-1?*\nAmount: 10.00',
        buttons: [
          { id: ids.approve, label: 'Confirm' },
          { id: ids.reject, label: 'Cancel' },
        ],
        fallbackText:
          '*Refund order A-1?*\nAmount: 10.00\n\nReply *yes* to confirm or *no* to cancel.',
        instruction: 'Reply *yes* to confirm or *no* to cancel.',
      },
    ]);
    // Telegram's callback_data holds 64 bytes.
    expect(Buffer.byteLength(ids.approve)).toBeLessThanOrEqual(64);
  });

  it('maps a press that lost its button id (only the label) to the one pending card it can be from', async () => {
    const setup = (pending: string[]) => {
      const { adapter, outbox } = fakeAdapter({ buttons: 3 });
      const service = fakeService(proposalFrames, {
        listActionProposals: async () =>
          pending.map((id) => ({ id, decision: 'pending', execution: null })),
        decideActionProposal: async (...args: unknown[]) => {
          service.decided.push(args);
          return { proposalDecision: { status: 'applied' }, text: 'approved!' };
        },
      });
      const handler = channel(adapter, service, { outcomeTimeoutMs: 0 });
      return { handler, service, outbox };
    };
    // A proposal made elsewhere is pending too: the label alone would be ambiguous as text.
    const one = setup([proposalId, 'proposal-from-the-web']);
    await one.handler.handle(request(inbound('refund A-1')));
    await one.handler.drain();
    await one.handler.handle(request(inbound(' confirm ', { buttonWithoutId: true })));
    await one.handler.drain();
    expect(one.service.decided).toEqual([
      [actor, 't', proposalId, { decision: 'approved', via: 'test' }],
    ]);
    expect(one.service.sends.map((send) => send.message)).toEqual(['refund A-1']);

    // No card remembered: the label is a text decision with nothing of this conversation to
    // decide (the pending proposal was never sent here). Not a label of ours: a message.
    const other = setup([proposalId]);
    await other.handler.handle(request(inbound('Confirm', { buttonWithoutId: true })));
    await other.handler.drain();
    await other.handler.handle(request(inbound('refund A-1')));
    await other.handler.drain();
    await other.handler.handle(request(inbound('Maybe', { buttonWithoutId: true })));
    await other.handler.drain();
    expect(other.service.decided).toEqual([]);
    expect(other.service.sends.map((send) => send.message)).toEqual(['refund A-1', 'Maybe']);
    expect(texts(other.outbox)[0]).toBe('There is nothing waiting for your confirmation here.');
  });

  it('reads its own button labels as decisions in the matching vocabulary', () => {
    for (const [texts, vocabulary] of [
      [DEFAULT_CHANNEL_TEXTS, DEFAULT_TEXT_ACTION_PROPOSAL_VOCABULARY],
      [
        ptBrChannelTexts,
        { ...DEFAULT_TEXT_ACTION_PROPOSAL_VOCABULARY, ...ptBrActionProposalText.vocabulary },
      ],
    ] as const) {
      expect(parseTextActionProposalCommand(texts.approve, vocabulary)).toMatchObject({
        status: 'command',
        decision: 'approved',
      });
      expect(parseTextActionProposalCommand(texts.reject, vocabulary)).toMatchObject({
        status: 'command',
        decision: 'rejected',
      });
    }
  });

  it('never guesses between two pending cards for a press without its id', async () => {
    const { adapter, outbox } = fakeAdapter({ buttons: 3 });
    const second = `proposal-${'c'.repeat(64)}`;
    const service = fakeService(
      [
        ...proposalFrames,
        { kind: 'tool-input-start', id: 'call-2', name: 'refund', toolKind: 'action' },
        {
          kind: 'approval-requested',
          id: 'call-2',
          approver: 'requester',
          target: { kind: 'proposal', proposalId: second },
        },
      ],
      {
        listActionProposals: async () => [
          { id: proposalId, decision: 'pending', execution: null },
          { id: second, decision: 'pending', execution: null },
        ],
        decideActionProposal: async (...args: unknown[]) => {
          service.decided.push(args);
          return { proposalDecision: { status: 'applied' }, text: 'approved!' };
        },
      },
    );
    const handler = channel(adapter, service);
    await handler.handle(request(inbound('two refunds')));
    await handler.drain();
    expect(outbox.filter((item) => item.message.buttons !== undefined)).toHaveLength(2);
    await handler.handle(request(inbound('Cancel', { buttonWithoutId: true })));
    await handler.drain();
    expect(service.decided).toEqual([]);
    // It goes on as a text decision, which asks which of this conversation's cards (#id).
    expect(service.sends.map((send) => send.message)).toEqual(['two refunds']);
    expect(texts(outbox).at(-1)).toBe(
      `Which one? Reply *yes #ID* or *no #ID*: #${proposalId}, #${second}`,
    );
  });

  it('without buttons, tells the person what to reply — in the configured vocabulary', async () => {
    const { adapter, outbox } = fakeAdapter();
    const service = fakeService(proposalFrames, {
      actionProposalVocabulary: () => ({
        ...DEFAULT_TEXT_ACTION_PROPOSAL_VOCABULARY,
        ...ptBrActionProposalText.vocabulary,
      }),
    });
    const handler = channel(adapter, service, {
      texts: {
        instruction: ({ approve, reject }) => `Responda *${approve}* ou *${reject}*.`,
      },
    });
    await handler.handle(request(inbound('reembolso')));
    await handler.drain();
    expect(texts(outbox)).toEqual([
      'I prepared the refund.',
      '*Refund order A-1?*\nAmount: 10.00\n\nResponda *sim* ou *não*.',
    ]);
  });

  it('speaks Brazilian Portuguese by default when the vocabulary is ptBrActionProposalText', async () => {
    const { adapter, outbox } = fakeAdapter({ buttons: 3 });
    const service = fakeService(proposalFrames, {
      actionProposalVocabulary: () => ({
        ...DEFAULT_TEXT_ACTION_PROPOSAL_VOCABULARY,
        ...ptBrActionProposalText.vocabulary,
      }),
    });
    const handler = channel(adapter, service);
    await handler.handle(request(inbound('reembolso')));
    await handler.drain();
    const ids = proposalButtonIds(proposalId);
    expect(outbox[1]?.message).toEqual({
      text: '*Refund order A-1?*\nAmount: 10.00',
      buttons: [
        { id: ids.approve, label: 'Confirmar' },
        { id: ids.reject, label: 'Cancelar' },
      ],
      fallbackText:
        '*Refund order A-1?*\nAmount: 10.00\n\nResponda *sim* para confirmar ou *não* para cancelar.',
      instruction: 'Responda *sim* para confirmar ou *não* para cancelar.',
    });
  });

  it('keeps the pt-BR base under partial overrides, and English for other vocabularies', async () => {
    const { adapter, outbox } = fakeAdapter();
    const service = fakeService([{ kind: 'fail', code: 'run_failed', message: 'boom' }], {
      actionProposalVocabulary: () => ptBrActionProposalText.vocabulary,
    });
    const handler = channel(adapter, service, {
      actor: (message) => (message.from === 'stranger' ? null : actor),
      texts: { unknownSender: 'Não conheço este número.' },
    });
    await handler.handle(request(inbound('oi', { id: 'm1', from: 'stranger' })));
    await handler.handle(request(inbound('oi', { id: 'm2' })));
    await handler.drain();
    expect(texts(outbox)).toEqual([
      'Não conheço este número.',
      'Desculpe, algo deu errado. Tente de novo, por favor.',
    ]);
    expect(channelTextsFor(DEFAULT_TEXT_ACTION_PROPOSAL_VOCABULARY)).toBe(DEFAULT_CHANNEL_TEXTS);
    expect(channelTextsFor({ ...DEFAULT_TEXT_ACTION_PROPOSAL_VOCABULARY, language: 'pt-PT' })).toBe(
      ptBrChannelTexts,
    );
    expect(channelTextsFor(null)).toBe(DEFAULT_CHANNEL_TEXTS);
  });

  it('names each proposal by #ID when the turn left several, and the tool when it has no confirmation', async () => {
    const { adapter, outbox } = fakeAdapter();
    const service = fakeService([
      ...proposalFrames,
      { kind: 'tool-input-start', id: 'call-2', name: 'cancel_order', toolKind: 'action' },
      {
        kind: 'approval-requested',
        id: 'call-2',
        approver: 'requester',
        target: { kind: 'proposal', proposalId: 'p2' },
      },
    ]);
    const handler = channel(adapter, service);
    await handler.handle(request(inbound('two refunds')));
    await handler.drain();
    expect(texts(outbox)[2]).toBe(
      '*Run cancel_order?*\n\nReply *yes #p2* to confirm or *no #p2* to cancel.',
    );
  });

  it('maps a button press to the policy-checked decision of its proposal, then relays the outcome', async () => {
    const { adapter, outbox } = fakeAdapter({ buttons: 3 });
    const id = `proposal-${'b'.repeat(64)}`;
    let polls = 0;
    const service = fakeService([], {
      listActionProposals: async () => {
        polls += 1;
        return [
          { id: 'proposal-other', decision: 'pending', execution: null },
          {
            id,
            decision: service.decided.length > 0 ? 'approved' : 'pending',
            execution: { status: polls > 2 ? 'succeeded' : 'queued' },
            ...(polls > 2 ? { outcome: { text: 'Refunded **10.00**.' } } : {}),
          },
        ];
      },
      decideActionProposal: async (...args: unknown[]) => {
        service.decided.push(args);
        return { proposalDecision: { status: 'applied' }, text: 'approved!' };
      },
    });
    const handler = channel(adapter, service, {
      thread: () => 'thread-1',
      outcomeTimeoutMs: 5_000,
    });
    const ids = proposalButtonIds(id);
    await handler.handle(request(inbound('Confirm', { buttonId: ids.approve })));
    await handler.drain();
    expect(service.decided).toEqual([
      [actor, 'thread-1', id, { decision: 'approved', via: 'test' }],
    ]);
    expect(service.sends).toEqual([]);
    expect(texts(outbox)).toEqual(['approved!', 'Refunded *10.00*.']);
  }, 10_000);

  it('answers a press on a proposal it cannot find, and reads a foreign button as text', async () => {
    const { adapter, outbox } = fakeAdapter({ buttons: 3 });
    const service = fakeService([{ kind: 'text', text: 'ok' }], {
      listActionProposals: async () => [],
      decideActionProposal: async () => ({ proposalDecision: { status: 'applied' }, text: '' }),
    });
    const handler = channel(adapter, service);
    await handler.handle(
      request(inbound('Cancel', { buttonId: proposalButtonIds('gone').reject })),
    );
    await handler.handle(request(inbound('Menu', { buttonId: 'menu:1' })));
    await handler.drain();
    expect(texts(outbox)).toEqual(['could not: not_found', 'ok']);
    expect(service.sends.map((send) => send.message)).toEqual(['Menu']);
  });

  it('blocking mode: sends what it has and says the approval is in the app', async () => {
    const { adapter, outbox } = fakeAdapter({ buttons: 3 });
    const service = fakeService(async function* () {
      yield { kind: 'text', text: 'Refunding.' };
      yield { kind: 'tool-input-start', id: 'call-1', name: 'refund', toolKind: 'action' };
      yield { kind: 'approval-requested', id: 'call-1', approver: 'requester' };
      // the stream stays open until someone decides
      await new Promise(() => {});
    });
    const handler = channel(adapter, service);
    await handler.handle(request(inbound('refund')));
    await handler.drain();
    expect(texts(outbox)).toEqual([
      'Refunding.',
      'This action needs an approval that can only be given in the app.',
    ]);
  });

  it('skips a question form it cannot put, and says when the turn failed', async () => {
    const { adapter, outbox } = fakeAdapter();
    const service = fakeService([
      { kind: 'elicitation', id: 'ask-1', request: { id: 'ask-1', source: 'ask', questions: [] } },
      { kind: 'fail', code: 'run_failed', message: 'boom' },
    ]);
    const handler = channel(adapter, service);
    await handler.handle(request(inbound('hi')));
    await handler.drain();
    expect(service.skipped).toEqual([{ actor, toolCallId: 'ask-1', via: 'test' }]);
    expect(texts(outbox)).toEqual(['Sorry, something went wrong. Please try again.']);
  });

  it('gives up on a turn after timeoutMs and cancels it', async () => {
    const { adapter, outbox } = fakeAdapter();
    const service = fakeService(async function* () {
      yield { kind: 'text', text: 'Partial' };
      await new Promise(() => {});
    });
    const handler = channel(adapter, service, { timeoutMs: 50 });
    await handler.handle(request(inbound('hi')));
    await handler.drain();
    expect(service.cancelled).toEqual(['run-1']);
    expect(texts(outbox)).toEqual(['Partial']);
  });

  it('retries a failing phase, then reports it to onError', async () => {
    const { adapter } = fakeAdapter();
    const errors: unknown[] = [];
    let calls = 0;
    const handler = channel(adapter, fakeService([]), {
      retry: { attempts: 2, backoffMs: 1 },
      actor: () => {
        calls += 1;
        throw new Error('directory down');
      },
      onError: (error) => errors.push(error),
    });
    await handler.handle(request(inbound('hi')));
    await handler.drain();
    expect(calls).toBe(2);
    expect(errors).toEqual([new Error('directory down')]);
  });
});
