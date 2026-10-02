import type { ModelProvider, ModelTurnArgs, ModelTurnResult } from '@dudousxd/nestjs-agent-core';
import {
  type Catalog,
  GENUI_TREE_COMPONENT,
  type GenuiCatalogScope,
  componentToText,
  defineCatalog,
  defineComponent,
  treeToText,
} from '@dudousxd/nestjs-agent-core/genui';
import { InMemoryAgentStore, InMemoryTokenStreamSink } from '@dudousxd/nestjs-agent-testing';
import { Injectable, Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentModule } from '../agent.module.js';
import { AgentService } from '../agent.service.js';
import { Agent } from '../decorator/agent.decorator.js';
import { HeaderActorResolver } from '../resolver/header-actor-resolver.js';
import {
  AgentGenuiModule,
  GENUI_CATALOG,
  GenuiCatalogResolver,
  InjectGenuiCatalog,
} from './agent-genui.module.js';

const ACTOR = { id: 'u1', roles: ['ADMIN'], tenantRef: 'acme' };

const Callout = defineComponent({
  name: 'Callout',
  title: 'Callout',
  description: 'A highlighted note.',
  props: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
});
const Stack = defineComponent({
  name: 'Stack',
  title: 'Stack',
  description: 'Lays children out vertically.',
  props: { type: 'object', properties: {} },
  children: true,
});
const catalog = defineCatalog([Callout, Stack]);

@Agent({ name: 'default', systemPrompt: 'genui module test agent', model: 'fake-1' })
@Injectable()
class DefaultAgent {}

/** Turn one calls `name` with `input`; later turns answer in prose. Records the tools it was shown. */
class CallingModel implements ModelProvider {
  turns = 0;
  tools: ModelTurnArgs['tools'] = [];
  constructor(
    private readonly name: string,
    private readonly input: unknown,
  ) {}
  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    this.turns += 1;
    if (this.turns === 1) this.tools = args.tools;
    const first = this.turns === 1;
    return {
      text: first ? '' : 'narration',
      toolCalls: first ? [{ id: 'c1', name: this.name, input: this.input }] : [],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

let app: NestExpressApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function boot(
  model: CallingModel,
  genui: ReturnType<typeof AgentGenuiModule.forRoot>,
  extra: { providers?: unknown[]; override?: (builder: TestingModuleBuilder) => void } = {},
) {
  const store = new InMemoryAgentStore();
  const sink = new InMemoryTokenStreamSink();
  const builder = Test.createTestingModule({
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
    providers: [DefaultAgent, ...((extra.providers ?? []) as never[])],
  });
  extra.override?.(builder);
  const moduleRef = await builder.compile();
  app = moduleRef.createNestApplication<NestExpressApplication>();
  await app.init();
  const { runId, threadId } = await app
    .get(AgentService)
    .chat({ actor: ACTOR, message: 'show me' });
  // Drained to the end: the run has settled and persisted by then.
  for await (const _chunk of sink.subscribe(runId)) {
    /* drain */
  }
  const messages = (await store.getThread(threadId))?.messages ?? [];
  return { assistants: messages.filter((message) => message.role === 'assistant'), app };
}

describe('AgentGenuiModule', () => {
  it('forRoot registers the tree tool; a terminal call is the answer', async () => {
    const root = {
      type: 'Stack',
      props: {},
      children: [{ type: 'Callout', props: { text: 'hi' } }],
    };
    const model = new CallingModel('ui__render', root);
    const { assistants } = await boot(
      model,
      AgentGenuiModule.forRoot({ catalog, mode: 'tree', terminal: true }),
    );
    expect(model.tools.map((tool) => tool.name)).toContain('ui__render');
    expect(model.turns).toBe(1);
    expect(assistants[0]?.ui).toEqual([
      {
        id: 'c1:ui:0',
        component: GENUI_TREE_COMPONENT,
        props: { root },
        version: 1,
        fallbackText: treeToText(catalog, root),
        componentVersions: { Stack: 1, Callout: 1 },
        toolCallId: 'c1',
      },
    ]);
  });

  it('per-component by default; the catalog is injectable', async () => {
    @Injectable()
    class ReadsCatalog {
      constructor(@InjectGenuiCatalog() readonly catalog: Catalog) {}
    }
    const model = new CallingModel('ui__show_callout', { text: 'hey' });
    const { assistants, app } = await boot(model, AgentGenuiModule.forRoot({ catalog }), {
      providers: [ReadsCatalog],
    });
    expect(model.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['ui__show_callout', 'ui__show_stack']),
    );
    expect(assistants[0]?.ui?.[0]).toMatchObject({ component: 'Callout', props: { text: 'hey' } });
    expect(app.get(ReadsCatalog).catalog).toBe(catalog);
  });

  it('overrideProvider(GENUI_CATALOG) swaps the catalog the tools are built from', async () => {
    const other = defineCatalog([
      defineComponent({ name: 'Badge', title: 'Badge', description: 'A badge.', props: {} }),
    ]);
    const model = new CallingModel('ui__show_badge', {});
    await boot(model, AgentGenuiModule.forRoot({ catalog }), {
      override: (builder) => {
        builder.overrideProvider(GENUI_CATALOG).useValue(other);
      },
    });
    const names = model.tools.map((tool) => tool.name);
    expect(names).toContain('ui__show_badge');
    expect(names).not.toContain('ui__show_callout');
  });

  it('forRootAsync builds its options from injected config', async () => {
    @Injectable()
    class GenuiConfig {
      readonly toolName = 'present';
    }
    @Module({ providers: [GenuiConfig], exports: [GenuiConfig] })
    class ConfigModule {}
    const root = { type: 'Callout', props: { text: 'async' } };
    const model = new CallingModel('present', root);
    const { assistants } = await boot(
      model,
      AgentGenuiModule.forRootAsync({
        imports: [ConfigModule],
        inject: [GenuiConfig],
        useFactory: (config: GenuiConfig) => ({
          catalog,
          mode: 'tree',
          treeToolName: config.toolName,
          terminal: true,
        }),
      }),
    );
    expect(model.turns).toBe(1);
    expect(assistants[0]?.ui?.[0]).toMatchObject({ component: GENUI_TREE_COMPONENT });
  });

  describe('with a per-request catalog resolver', () => {
    const LeadCard = defineComponent({
      name: 'LeadCard',
      title: 'Lead card',
      description: 'An acme lead.',
      props: { type: 'object', properties: { lead: { type: 'string' } }, required: ['lead'] },
      version: 7,
    });

    @Injectable()
    class TenantCatalogs {
      forTenant(tenant: string | undefined): Catalog {
        return defineCatalog(tenant === 'acme' ? [Callout, LeadCard] : [Callout]);
      }
    }

    @Injectable()
    class TenantCatalogResolver extends GenuiCatalogResolver {
      readonly scopes: GenuiCatalogScope[] = [];
      constructor(private readonly catalogs: TenantCatalogs) {
        super();
      }
      resolve(scope: GenuiCatalogScope): Catalog {
        this.scopes.push(scope);
        return this.catalogs.forTenant(scope.tenant);
      }
    }

    @Module({ providers: [TenantCatalogs], exports: [TenantCatalogs] })
    class TenantModule {}

    it("describes and validates the show tool against the tenant's catalog", async () => {
      const model = new CallingModel('ui__show', { component: 'LeadCard', props: { lead: 'Ada' } });
      const { assistants, app } = await boot(
        model,
        AgentGenuiModule.forRootAsync({
          imports: [TenantModule],
          useFactory: () => ({ showTool: true, terminal: true }),
          resolver: TenantCatalogResolver,
        }),
      );
      const show = model.tools.find((tool) => tool.name === 'ui__show');
      expect(show?.description).toContain('An acme lead.');
      expect(assistants[0]?.ui).toEqual([
        {
          id: 'c1:ui:0',
          component: 'LeadCard',
          props: { lead: 'Ada' },
          version: 7,
          fallbackText: componentToText(defineCatalog([Callout, LeadCard]), 'LeadCard', {
            lead: 'Ada',
          }),
          toolCallId: 'c1',
        },
      ]);
      const resolver = app.get(GenuiCatalogResolver) as TenantCatalogResolver;
      expect(resolver.scopes[0]).toMatchObject({ tenant: 'acme', actor: { id: 'u1' } });
      expect(resolver.scopes.every((scope) => typeof scope.threadId === 'string')).toBe(true);
    });

    it('overrideProvider(GenuiCatalogResolver) replaces it in a test', async () => {
      const model = new CallingModel('ui__show', { component: 'LeadCard', props: { lead: 'Ada' } });
      const { assistants } = await boot(
        model,
        AgentGenuiModule.forRootAsync({
          imports: [TenantModule],
          useFactory: () => ({ showTool: true }),
          resolver: TenantCatalogResolver,
        }),
        {
          override: (builder) => {
            builder
              .overrideProvider(GenuiCatalogResolver)
              .useValue({ resolve: () => defineCatalog([Callout]) });
          },
        },
      );
      expect(model.turns).toBe(2);
      expect(assistants[0]?.ui).toBeUndefined();
      expect(assistants[0]?.toolResults?.[0]?.error).toMatch(/unknown component "LeadCard"/);
    });
  });
});
