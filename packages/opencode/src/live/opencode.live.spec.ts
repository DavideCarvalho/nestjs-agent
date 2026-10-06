import 'reflect-metadata';
import type { Actor, AgentStreamEvent } from '@dudousxd/nestjs-agent-core';
import { DurableModule } from '@dudousxd/nestjs-durable';
import { InMemoryStateStore } from '@dudousxd/nestjs-durable-core';
import { EventEmitterTransport } from '@dudousxd/nestjs-durable-transport-event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { afterEach, describe, expect, it } from 'vitest';
import type { OpenCodeClient } from '../client.js';
import { openCodeDurable } from '../durable/index.js';
import { openCode } from '../engine.js';
import type { OpenCodeHost, OpenCodeServer } from '../host.js';
import { type Harness, bootEngine, frames, framesUntil, textOf } from '../testing/harness.js';
import { OpenCodeTurns } from '../turns.js';
import { realClient } from './client-shape.js';

/**
 * Against a real OpenCode 2 server — skipped unless one is configured:
 *
 *   OPENCODE_LIVE_URL=http://127.0.0.1:4096 OPENCODE_LIVE_PASSWORD=… \
 *   OPENCODE_LIVE_MODEL=opencode-go/longcat-2.5-preview-free OPENCODE_LIVE_DIR=/tmp/work \
 *   pnpm vitest run packages/opencode/src/live
 *
 * The server needs a key for the model's provider (`integration.connect.key`). Models answer
 * differently from run to run: these check what the engine does with what OpenCode sends, and the
 * prompts leave the model little room.
 */
const url = process.env.OPENCODE_LIVE_URL;
const live = describe.skipIf(url === undefined);
const TIMEOUT = 180_000;
const actor: Actor = { id: 'u1', roles: ['ADMIN'] };

class LiveHost implements OpenCodeHost {
  readonly client: OpenCodeClient = realClient(url ?? '', process.env.OPENCODE_LIVE_PASSWORD ?? '');
  bootId = 'live';

  async server(): Promise<OpenCodeServer> {
    return { client: this.client, key: 'live', bootId: this.bootId };
  }

  async session() {
    const [providerID, ...rest] = (process.env.OPENCODE_LIVE_MODEL ?? '').split('/');
    return {
      model: { providerID: providerID ?? '', id: rest.join('/') },
      location: { directory: process.env.OPENCODE_LIVE_DIR ?? process.cwd() },
      permissions: [
        { action: '*', resource: '*', effect: 'deny' as const },
        { action: 'question', resource: '*', effect: 'allow' as const },
        { action: 'webfetch', resource: '*', effect: 'ask' as const },
      ],
    };
  }
}

const liveHost = new LiveHost();

const kinds = (fs: AgentStreamEvent[]) => [...new Set(fs.map((f) => f.kind))];

live('openCode against a real OpenCode 2 server', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.app.close();
    h = undefined;
  });

  it(
    'streams and persists a plain answer',
    async () => {
      h = await bootEngine({ engine: () => openCode({ host: liveHost }) });
      const { runId, threadId } = await h.service.chat({
        actor,
        message: 'Reply with exactly the words: hello from opencode',
      });
      const fs = await frames(h.service, runId);
      expect(textOf(fs).toLowerCase()).toContain('hello from opencode');
      expect(kinds(fs)).toEqual(expect.arrayContaining(['step-start', 'text', 'step-finish']));
      const finish = fs.find((f) => f.kind === 'step-finish' && f.usage !== undefined);
      expect(finish && 'usage' in finish && finish.usage?.inputTokens).toBeGreaterThan(0);
      const thread = await h.store.getThread(threadId);
      expect(thread?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(thread?.messages[1]?.content.toLowerCase()).toContain('hello from opencode');
    },
    TIMEOUT,
  );

  it(
    'puts an OpenCode permission to the person, and OpenCode honours the rejection',
    async () => {
      h = await bootEngine({ engine: () => openCode({ host: liveHost }) });
      const { runId } = await h.service.chat({
        actor,
        message: 'Use the webfetch tool to fetch https://example.com, then tell me the page title.',
      });
      const asked = await framesUntil(h.service, runId, (f) => f.kind === 'approval-requested');
      const call = asked.find((f) => f.kind === 'tool-input-available' && f.toolKind === 'action');
      expect(call).toMatchObject({ name: 'webfetch', input: { url: 'https://example.com' } });
      const id = (call as { id: string }).id;

      await h.service.reject(actor, id, 'not now');
      const fs = await frames(h.service, runId);
      expect(fs).toContainEqual({ kind: 'tool-output-denied', id, reason: 'not now' });
      // OpenCode went on after the rejection and answered.
      expect(textOf(fs).length).toBeGreaterThan(0);
    },
    TIMEOUT,
  );

  it(
    'asks a question form as an elicitation and answers it',
    async () => {
      h = await bootEngine({ engine: () => openCode({ host: liveHost }) });
      const { runId } = await h.service.chat({
        actor,
        message:
          'Use the question tool to ask me which color I prefer, with exactly the options Red and Blue. After I answer, reply with only the color I chose.',
      });
      const asked = await framesUntil(h.service, runId, (f) => f.kind === 'elicitation');
      const elicitation = asked.at(-1);
      if (elicitation?.kind !== 'elicitation') throw new Error('expected an elicitation');
      const question = elicitation.request.questions[0];
      const blue = question?.options?.find((o) => o.label.toLowerCase() === 'blue');
      expect(blue).toBeDefined();
      // The question tool is the form: it is not shown as a call of its own.
      expect(asked.some((f) => f.kind === 'tool-input-start' && f.name === 'question')).toBe(false);

      await h.service.answer(actor, elicitation.id, { [question?.id ?? '']: [blue?.value ?? ''] });
      const fs = await frames(h.service, runId);
      expect(textOf(fs).toLowerCase()).toContain('blue');
    },
    TIMEOUT,
  );

  it(
    'durable: a turn parked on a permission is answered from a process that never followed it',
    async () => {
      h = await bootEngine({
        engine: () => openCodeDurable({ host: liveHost }),
        imports: [
          DurableModule.forRoot({
            store: new InMemoryStateStore(),
            transport: new EventEmitterTransport(new EventEmitter2()),
          }),
        ],
      });
      const { runId } = await h.service.chat({
        actor,
        message: 'Use the webfetch tool to fetch https://example.com, then tell me the page title.',
      });
      const asked = await framesUntil(h.service, runId, (f) => f.kind === 'approval-requested');
      const id = (asked.at(-1) as { id: string }).id;
      // A restart: no live turn, no listener — only the journal and the store.
      h.app.get(OpenCodeTurns).drop(runId);
      await h.service.reject(actor, id, 'not now');
      const fs = await frames(h.service, runId);
      expect(fs).toContainEqual({ kind: 'tool-output-denied', id, reason: 'not now' });
      expect(textOf(fs).length).toBeGreaterThan(0);
    },
    TIMEOUT,
  );
});
