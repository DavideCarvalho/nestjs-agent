import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelProvider, ModelTurnArgs, ModelTurnResult } from '@dudousxd/nestjs-agent-core';
import { defineCatalog, defineComponent } from '@dudousxd/nestjs-agent-core/genui';
import { InMemoryAgentStore, InMemoryTokenStreamSink } from '@dudousxd/nestjs-agent-testing';
import { Injectable } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { AgentModule } from '../agent.module.js';
import { AgentService } from '../agent.service.js';
import { Agent } from '../decorator/agent.decorator.js';
import { HeaderActorResolver } from '../resolver/header-actor-resolver.js';
import { AGENT_GENUI, type AgentGenui, AgentGenuiModule } from './agent-genui.module.js';

const ACTOR = { id: 'u1', roles: ['ADMIN'] };

const Callout = defineComponent(
  {
    name: 'Callout',
    title: 'Callout',
    description: 'A highlighted note.',
    props: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    fallbackText: (props: { text: string }) => props.text,
  },
  { channels: { whatsapp: (props) => ({ text: `> ${props.text}` }) } },
);
const catalog = defineCatalog([Callout]);

@Agent({ name: 'default', systemPrompt: 'genui channels test agent', model: 'fake-1' })
@Injectable()
class DefaultAgent {}

/** Answers in prose; records the tools each turn was shown. */
class RecordingModel implements ModelProvider {
  shown: string[][] = [];
  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    this.shown.push(args.tools.map((tool) => tool.name));
    return { text: 'ok', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

/** A kit the dev plugin would have written (`.genui/sandbox-kit.json`). */
const work = mkdtempSync(join(tmpdir(), 'genui-kit-'));
mkdirSync(join(work, '.genui'));
writeFileSync(
  join(work, '.genui/sandbox-kit.json'),
  JSON.stringify({
    version: 1,
    components: [{ name: 'Slider', props: [{ name: 'value', type: 'number[]', required: true }] }],
    theme: { vars: { '--primary': 'oklch(0.2 0 0)' } },
    kit: { url: '/@genui-sandbox-kit/kit.js?v=abc', hash: 'abc' },
    tailwind: { url: '/@genui-sandbox-kit/tailwind.js' },
  }),
);
afterAll(() => rmSync(work, { recursive: true, force: true }));

let app: NestExpressApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function boot(model: RecordingModel, genui: ReturnType<typeof AgentGenuiModule.forRoot>) {
  const store = new InMemoryAgentStore();
  const sink = new InMemoryTokenStreamSink();
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        model,
        store,
        sink,
        actorResolver: new HeaderActorResolver(),
        defaultAgent: 'default',
      }),
      genui,
    ],
    providers: [DefaultAgent],
  }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>();
  await app.init();
  const chat = async (channel?: string) => {
    const { runId } = await (app as NestExpressApplication)
      .get(AgentService)
      .chat({ actor: ACTOR, message: 'hi', ...(channel !== undefined ? { channel } : {}) });
    for await (const _chunk of sink.subscribe(runId)) {
      /* drain */
    }
  };
  return { app, chat };
}

describe('AgentGenuiModule — channels and the sandbox kit', () => {
  it('offers each channel the tools of its own mode', async () => {
    const model = new RecordingModel();
    const { chat } = await boot(
      model,
      AgentGenuiModule.forRoot({
        catalog,
        sandbox: true,
        channels: { web: { mode: 'tree' }, whatsapp: { mode: 'per-component' } },
      }),
    );
    await chat();
    await chat('whatsapp');
    expect(model.shown[0]).toContain('ui__render');
    expect(model.shown[0]).not.toContain('ui__show_callout');
    expect(model.shown[1]).toContain('ui__show_callout');
    expect(model.shown[1]).not.toContain('ui__render');
    expect(model.shown[1]).not.toContain('ui__show_sandbox');
  });

  it('finds the kit through the dev descriptor and tells GET /config and the model', async () => {
    const { app: booted } = await boot(
      new RecordingModel(),
      AgentGenuiModule.forRoot({
        catalog,
        sandbox: { kit: true, tailwind: true },
        channels: { whatsapp: {} },
        sandboxKit: { root: work, production: false },
      }),
    );
    const response = await request(booted.getHttpServer())
      .get('/agent/config')
      .set('x-actor-id', 'u1')
      .expect(200);
    expect(response.body.genui).toEqual({
      sandbox: {
        theme: true,
        tailwind: { url: '/@genui-sandbox-kit/tailwind.js' },
        kit: { url: '/@genui-sandbox-kit/kit.js?v=abc', hash: 'abc' },
      },
    });
    const genui = booted.get<AgentGenui>(AGENT_GENUI);
    expect(genui.channels).toEqual({ whatsapp: {} });
    expect(genui.base.sandbox).toMatchObject({ tailwind: true });
    expect(genui.catalog.get('Sandbox')?.description).toContain('- <Slider>');
    expect(genui.catalog.get('Sandbox')?.description).toContain('var(--primary)');
  });

  it('no sandbox → no genui facts on GET /config', async () => {
    const { app: booted } = await boot(new RecordingModel(), AgentGenuiModule.forRoot({ catalog }));
    const response = await request(booted.getHttpServer())
      .get('/agent/config')
      .set('x-actor-id', 'u1')
      .expect(200);
    expect(response.body.genui).toBeUndefined();
  });
});
