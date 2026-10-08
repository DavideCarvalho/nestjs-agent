import {
  type ModelProvider,
  type ModelTurnArgs,
  type ModelTurnResult,
  encodeStreamEvent,
} from '@dudousxd/nestjs-agent-core';
import { type Catalog, defineCatalog } from '@dudousxd/nestjs-agent-core/genui';
import { Card, Chart, DataTable, KpiCards } from '@dudousxd/nestjs-agent-core/genui/builtins';
import { InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { agUiAdapter } from '../ag-ui/ag-ui.adapter.js';
import { AgentModule } from '../agent.module.js';
import { AgentService } from '../agent.service.js';
import { HeaderActorResolver } from '../resolver/header-actor-resolver.js';
import { AgentGenuiModule, type AgentGenuiOptions } from './agent-genui.module.js';

/**
 * Progressive `ui__render` through the real module, over HTTP: the native SSE stream, its replay,
 * and AG-UI. Mirrors `adonis-agent`'s `genui-progressive-stream.spec.ts` — the two libraries share
 * the wire format (`partial` ui frames under `<toolCallId>:ui:0`, positional node ids).
 */

const catalog = defineCatalog([Card, Chart, DataTable, KpiCards]);

const chart = (type: string) => ({
  type: 'Chart',
  props: {
    type,
    title: 'Revenue',
    xKey: 'month',
    series: [{ key: 'revenue' }],
    data: [
      { month: 'Jan', revenue: 1200 },
      { month: 'Feb', revenue: 1800 },
    ],
  },
});

const dashboard = (chartType = 'bar') => ({
  type: 'Card',
  props: { title: 'Sales dashboard', subtitle: 'January – June' },
  children: [
    { type: 'KpiCards', props: { items: [{ label: 'Revenue', value: '$3.0k', trend: 'up' }] } },
    chart(chartType),
  ],
});

/**
 * A model that streams its `ui__render` arguments in chunks, as `aiSdkModel` relays a real
 * provider's `tool-input-delta`s. Turn 0 renders `first`; after a tool error, turn 1 renders `retry`.
 */
class StreamingTreeModel implements ModelProvider {
  constructor(
    private readonly first: unknown,
    private readonly retry: unknown = dashboard(),
  ) {}

  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    const turn = args.messages.filter((message) => message.role === 'assistant').length;
    const results = args.messages.flatMap((message) => message.toolResults ?? []);
    if (results.some((result) => result.error === undefined)) {
      await args.sink.write(encodeStreamEvent({ kind: 'text', text: 'There.' }));
      return { text: 'There.', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
    }
    const input = turn === 0 ? this.first : this.retry;
    const id = `call-${turn}`;
    const json = JSON.stringify(input);
    await args.sink.write(
      encodeStreamEvent({ kind: 'tool-input-start', id, name: 'ui__render', toolKind: 'read' }),
    );
    for (let at = 0; at < json.length; at += 24) {
      await args.sink.write(
        encodeStreamEvent({ kind: 'tool-input-delta', id, delta: json.slice(at, at + 24) }),
      );
    }
    await args.sink.write(
      encodeStreamEvent({
        kind: 'tool-input-available',
        id,
        name: 'ui__render',
        input,
        toolKind: 'read',
      }),
    );
    return {
      text: '',
      toolCalls: [{ id, name: 'ui__render', input }],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

const headers = { 'content-type': 'application/json', 'x-actor-id': 'u1' };

let app: NestExpressApplication | undefined;
let url = '';
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function boot(
  model: ModelProvider,
  options: Partial<AgentGenuiOptions> & { catalog?: Catalog } = {},
): Promise<void> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        model,
        store: new InMemoryAgentStore(),
        actorResolver: new HeaderActorResolver(),
        followUps: false,
        adapters: [agUiAdapter({ quietMs: 80 })],
      }),
      AgentGenuiModule.forRoot({
        catalog,
        streaming: 'partial',
        streamingThrottleMs: 0,
        ...options,
      }),
    ],
  }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>();
  await app.listen(0, '127.0.0.1');
  url = (await app.getUrl()).replace('[::1]', '127.0.0.1');
}

interface SseFrame {
  id?: string;
  event?: string;
  data: Record<string, unknown>;
}

async function readSse(response: Response): Promise<SseFrame[]> {
  const text = await response.text();
  return text
    .split('\n\n')
    .filter((block) => block.includes('data: '))
    .map((block) => {
      const frame: SseFrame = { data: {} };
      for (const line of block.split('\n')) {
        if (line.startsWith('id: ')) frame.id = line.slice(4);
        else if (line.startsWith('event: ')) frame.event = line.slice(7);
        else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6));
      }
      return frame;
    });
}

async function chat(body: Record<string, unknown> = {}) {
  const response = await fetch(`${url}/agent/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message: 'dashboard', ...body }),
  });
  const runId = response.headers.get('x-agent-run-id') as string;
  const threadId = response.headers.get('x-agent-thread-id') as string;
  return { runId, threadId, frames: await readSse(response) };
}

async function persistedUi(threadId: string) {
  const thread = (await (await fetch(`${url}/agent/threads/${threadId}`, { headers })).json()) as {
    messages: { ui?: Record<string, unknown>[] }[];
  };
  return thread.messages.flatMap((message) => message.ui ?? []);
}

const uiFrames = (frames: SseFrame[]) => frames.filter((frame) => frame.data.kind === 'ui');
type Node = { id: string; type: string; incomplete?: true; held?: true; children?: Node[] };
const rootOf = (frame: SseFrame) => (frame.data.props as { root?: Node }).root;

describe('progressive ui__render over the native stream', () => {
  it('streams partial trees under the final id, then the validated tree replaces them', async () => {
    await boot(new StreamingTreeModel(dashboard()));
    const { frames, threadId } = await chat();
    const ui = uiFrames(frames);
    expect(ui.length).toBeGreaterThan(3);
    expect(new Set(ui.map((frame) => frame.data.id))).toEqual(new Set(['call-0:ui:0']));
    const finalFrame = ui.at(-1) as SseFrame;
    const previews = ui.slice(0, -1);
    expect(previews.every((frame) => frame.data.partial === true)).toBe(true);
    // No preview carries fallback text: there is nothing final to say yet.
    expect(previews.some((frame) => 'fallbackText' in frame.data)).toBe(false);
    // The layout grows: the root first, flagged incomplete, then its children one by one.
    expect(rootOf(previews[0] as SseFrame)).toMatchObject({
      id: 'root',
      type: 'Card',
      incomplete: true,
    });
    expect(
      previews.some((frame) =>
        rootOf(frame)?.children?.some((child) => child.type === 'Chart' && child.incomplete),
      ),
    ).toBe(true);
    // The final frame is the validated push, as without previews.
    expect(finalFrame.data.partial).toBeUndefined();
    expect(finalFrame.data.fallbackText).toEqual(expect.stringContaining('Sales dashboard'));
    expect(rootOf(finalFrame)).toEqual(dashboard());
    // The previews precede the tool's outcome; the final frame too.
    const outcome = frames.findIndex((frame) => frame.data.kind === 'tool-output');
    expect(frames.indexOf(finalFrame)).toBeLessThan(outcome);

    // Persisted: the final tree alone.
    const persisted = await persistedUi(threadId);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ id: 'call-0:ui:0', component: 'genui:tree' });
    expect(persisted[0]?.partial).toBeUndefined();
    expect(JSON.stringify(persisted)).not.toMatch(/incomplete|held/);
  });

  it('replays from the sink (and from any point in it) to the same final tree', async () => {
    await boot(new StreamingTreeModel(dashboard()));
    const { runId, frames } = await chat();
    const last = uiFrames(frames).at(-1) as SseFrame;
    // What a re-attach reads: the run's buffered stream from its first chunk, in write order.
    let text = '';
    const decoder = new TextDecoder();
    for await (const chunk of (app as NestExpressApplication).get(AgentService).subscribe(runId)) {
      text += decoder.decode(chunk, { stream: true });
    }
    const replay = text
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => ({ data: JSON.parse(line) as Record<string, unknown> }));
    expect(uiFrames(replay).map((frame) => frame.data)).toEqual(
      uiFrames(frames).map((frame) => frame.data),
    );
    // Re-attached mid-preview (`?after=<seq>` skips what came before): it still ends on the final tree.
    const rest = uiFrames(replay.slice(Math.floor(replay.length / 3)));
    expect(rest.at(-1)?.data).toEqual(last.data);
  });

  it('streams nothing partial by default (streaming: complete)', async () => {
    await boot(new StreamingTreeModel(dashboard()), { streaming: 'complete' });
    const ui = uiFrames((await chat()).frames);
    expect(ui).toHaveLength(1);
    expect(ui[0]?.data.partial).toBeUndefined();
  });

  it('validates only the final tree: an invalid one is withdrawn, the retry replaces nothing of it', async () => {
    await boot(new StreamingTreeModel(dashboard('pie'), dashboard('bar')));
    const { frames, threadId } = await chat();
    const kinds = frames.map((frame) => {
      if (frame.data.kind !== 'ui') return String(frame.data.kind);
      const state =
        frame.data.partial !== true
          ? 'final'
          : Object.keys(frame.data.props as object).length === 0
            ? 'withdrawn'
            : 'partial';
      return `ui:${String(frame.data.id)}:${state}`;
    });
    // The pie chart previewed (props are not validated while streaming)...
    expect(kinds).toContain('ui:call-0:ui:0:partial');
    // ...was refused by the final validation, and its preview withdrawn before the error.
    const withdrawn = kinds.indexOf('ui:call-0:ui:0:withdrawn');
    const error = kinds.indexOf('tool-output-error');
    expect(withdrawn).toBeGreaterThan(-1);
    expect(withdrawn).toBeLessThan(error);
    expect(kinds).not.toContain('ui:call-0:ui:0:final');
    // The model read the error and retried: that call previews and lands under its own id.
    expect(kinds.filter((kind) => kind === 'ui:call-1:ui:0:final')).toHaveLength(1);
    expect((await persistedUi(threadId)).map((ui) => ui.id)).toEqual(['call-1:ui:0']);
  });

  it('holds a component that streams complete until its subtree has arrived', async () => {
    await boot(new StreamingTreeModel(dashboard()), {
      catalog: defineCatalog([Card, KpiCards, { ...Chart, streaming: 'complete' }]),
    });
    const previews = uiFrames((await chat()).frames).filter((frame) => frame.data.partial);
    const charts = previews
      .map((frame) => rootOf(frame)?.children?.find((child) => child.type === 'Chart'))
      .filter((node) => node !== undefined) as Array<Node & { props: Record<string, unknown> }>;
    expect(charts.length).toBeGreaterThan(1);
    // Every Chart drawn while it was being written is a placeholder with no props...
    const writing = charts.filter((node) => node.incomplete === true);
    expect(writing.length).toBeGreaterThan(0);
    for (const node of writing)
      expect(node).toEqual({
        id: 'root.1',
        type: 'Chart',
        props: {},
        incomplete: true,
        held: true,
      });
    // ...and the first one with props has them whole.
    const drawn = charts.find((node) => node.held === undefined);
    expect(drawn?.props).toEqual(chart('bar').props);
  });

  it('previews only for a client that draws the tree: a text-only one gets the final text', async () => {
    await boot(new StreamingTreeModel(dashboard()));
    const { frames } = await chat({ uiCapabilities: { components: [] } });
    expect(uiFrames(frames)).toEqual([]);
  });
});

describe('progressive ui__render over AG-UI', () => {
  it('sends each preview as an agora.ui event with the same id, the final one last', async () => {
    await boot(new StreamingTreeModel(dashboard()));
    const response = await fetch(`${url}/agent/ag-ui`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        threadId: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        messages: [{ id: 'm1', role: 'user', content: 'dashboard' }],
      }),
    });
    const events = (await readSse(response)).map((frame) => frame.data);
    const ui = events.filter((event) => event.type === 'CUSTOM' && event.name === 'agora.ui');
    const values = ui.map((event) => event.value as Record<string, unknown>);
    expect(values.length).toBeGreaterThan(3);
    expect(new Set(values.map((value) => value.id))).toEqual(new Set(['call-0:ui:0']));
    expect(values.slice(0, -1).every((value) => value.partial === true)).toBe(true);
    expect(values.at(-1)?.partial).toBeUndefined();
    expect((values.at(-1) as { props: { root: unknown } }).props.root).toEqual(dashboard());
  });
});
