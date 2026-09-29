import { InMemoryAgentStore, InMemoryTokenStreamSink } from '@dudousxd/nestjs-agent-testing';
import { describe, expect, it } from 'vitest';
import {
  DefaultRolesPolicy,
  type ModelProvider,
  type ModelTurnArgs,
  type ModelTurnResult,
  ToolRegistry,
  runAgentLoop,
} from '../index.js';
import { BUILTIN_COMPONENTS, LAYOUT_COMPONENTS } from './builtins.js';
import { defineCatalog, defineComponent } from './catalog.js';
import { type GenuiCatalogScope, genuiTools } from './tools.js';
import { GENUI_TREE_COMPONENT } from './tree.js';

const ACTOR = { id: 'u1', roles: ['ADMIN'] };
const catalog = defineCatalog([...BUILTIN_COMPONENTS, ...LAYOUT_COMPONENTS]);

/** First turn calls `name` with `input`; later turns answer in prose. Counts its turns. */
class CallingModel implements ModelProvider {
  turns = 0;
  seenTools: ModelTurnArgs['tools'] = [];
  constructor(
    private readonly name: string,
    private readonly input: unknown,
  ) {}
  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    this.turns += 1;
    if (this.turns === 1) this.seenTools = args.tools;
    const first = args.messages.every((message) => message.role !== 'assistant');
    return {
      text: first ? '' : 'narration',
      toolCalls: first ? [{ id: 'c1', name: this.name, input: this.input }] : [],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

async function run(
  tools: ReturnType<typeof genuiTools>,
  model: CallingModel,
  actor: { id: string; roles: string[]; tenantRef?: string } = ACTOR,
) {
  const store = new InMemoryAgentStore();
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool.spec, tool.handler);
  const thread = await store.createThread({ actor });
  const sink = new InMemoryTokenStreamSink();
  await runAgentLoop(
    {
      model,
      store,
      registry,
      rolesPolicy: new DefaultRolesPolicy(),
      modelId: 'fake',
      day: '2026-09-29',
      systemPrompt: 'test',
    },
    { threadId: thread.id, actor, userText: 'show me' },
    {
      runId: 'run-1',
      openSink: () => sink.open('run-1'),
      awaitApproval: async () => ({ approved: true }),
      step: (_name, fn) => fn(),
    },
  );
  const messages = (await store.getThread(thread.id))?.messages ?? [];
  return messages.filter((message) => message.role === 'assistant');
}

describe('genui tools in the agent loop', () => {
  it('a per-component call lands on the message as that component', async () => {
    const model = new CallingModel('ui__show_callout', { text: 'Heads up', tone: 'warning' });
    const [first] = await run(genuiTools(catalog), model);
    expect(first?.ui).toEqual([
      {
        id: 'c1:ui:0',
        component: 'Callout',
        props: { text: 'Heads up', tone: 'warning' },
        toolCallId: 'c1',
      },
    ]);
    expect(model.turns).toBe(2);
  });

  it('a terminal tree call is the answer: one frame, and no narrating model call', async () => {
    const root = {
      type: 'Card',
      props: { title: 'T' },
      children: [{ type: 'Text', props: { text: 'x' } }],
    };
    const model = new CallingModel('renderResult', root);
    const assistants = await run(
      genuiTools(catalog, { mode: 'tree', terminal: true, treeToolName: 'renderResult' }),
      model,
    );
    expect(model.turns).toBe(1);
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.ui).toEqual([
      { id: 'c1:ui:0', component: GENUI_TREE_COMPONENT, props: { root }, toolCallId: 'c1' },
    ]);
  });

  it('an invalid tree is refused to the model, which gets another turn', async () => {
    const model = new CallingModel('ui__render', { type: 'Nope', props: {} });
    const [first] = await run(genuiTools(catalog, { mode: 'tree', terminal: true }), model);
    expect(model.turns).toBe(2);
    expect(first?.ui).toBeUndefined();
    expect(first?.toolResults?.[0]?.error).toMatch(/unknown component "Nope"/);
  });

  it("a tenant's own component: described to the model for its turn, validated on the call", async () => {
    const tenantCard = defineComponent({
      name: 'LeadCard',
      title: 'Lead card',
      description: 'A lead in the acme pipeline.',
      props: { type: 'object', properties: { lead: { type: 'string' } }, required: ['lead'] },
      version: 4,
    });
    const scopes: GenuiCatalogScope[] = [];
    const tools = genuiTools(defineCatalog([]), {
      showTool: true,
      terminal: true,
      resolveCatalog: (scope) => {
        scopes.push(scope);
        return defineCatalog(scope.tenant === 'acme' ? [tenantCard] : []);
      },
    });
    const model = new CallingModel('ui__show', { component: 'LeadCard', props: { lead: 'Ada' } });
    const [first] = await run(tools, model, { ...ACTOR, tenantRef: 'acme' });
    expect(model.seenTools.find((tool) => tool.name === 'ui__show')?.description).toContain(
      'A lead in the acme pipeline.',
    );
    expect(first?.ui).toEqual([
      {
        id: 'c1:ui:0',
        component: 'LeadCard',
        props: { lead: 'Ada' },
        version: 4,
        toolCallId: 'c1',
      },
    ]);
    expect(scopes.every((scope) => scope.tenant === 'acme' && scope.threadId !== undefined)).toBe(
      true,
    );
  });
});
