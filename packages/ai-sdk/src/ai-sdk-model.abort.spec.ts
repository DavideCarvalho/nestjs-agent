import {
  DefaultRolesPolicy,
  InMemoryAgentStore,
  RunCancelledError,
  type SinkWriter,
  ToolRegistry,
  runAgentLoop,
} from '@dudousxd/nestjs-agent-core';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { aiSdkModel } from './ai-sdk-model.js';

/**
 * A Stop handed to the loop as `abortSignal` reaches the real `streamText` call: the provider sees
 * the abort, the turn unwinds as a cancel rather than a failure, and nothing of the step is kept.
 */

const HANG_MS = 3000;

function abortedOrTimeout(signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), HANG_MS);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

describe('aiSdkModel under a stopped run', () => {
  it('ends the stream at the Stop and unwinds the turn as cancelled', async () => {
    let streaming!: () => void;
    const started = new Promise<void>((resolve) => {
      streaming = resolve;
    });
    let providerSawAbort: boolean | undefined;
    const mock = new MockLanguageModelV3({
      doStream: async (options) => ({
        stream: new ReadableStream({
          async start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: '1' });
            controller.enqueue({ type: 'text-delta', id: '1', delta: 'Hel' });
            streaming();
            providerSawAbort = await abortedOrTimeout(options.abortSignal);
            if (providerSawAbort) {
              controller.error(new DOMException('This operation was aborted', 'AbortError'));
              return;
            }
            controller.enqueue({ type: 'text-delta', id: '1', delta: 'lo' });
            controller.enqueue({ type: 'text-end', id: '1' });
            controller.enqueue({
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            });
            controller.close();
          },
        }),
      }),
    });
    const store = new InMemoryAgentStore();
    const actor = { id: 'u1', roles: ['ADMIN'] };
    const thread = await store.createThread({ actor });
    const writer: SinkWriter = { write() {}, end() {}, fail() {} };
    const stop = new AbortController();
    const begun = Date.now();
    const run = runAgentLoop(
      {
        model: aiSdkModel(mock),
        store,
        registry: new ToolRegistry(),
        rolesPolicy: new DefaultRolesPolicy(),
        modelId: 'mock',
        day: '2026-10-08',
        systemPrompt: 'test',
      },
      { threadId: thread.id, actor, userText: 'hi' },
      {
        runId: 'run-1',
        openSink: () => writer,
        awaitApproval: async () => ({ approved: true }),
        step: (_name, fn) => fn(),
        abortSignal: stop.signal,
      },
    );
    await started;
    stop.abort(new RunCancelledError());
    await expect(run).rejects.toBeInstanceOf(RunCancelledError);
    expect(providerSawAbort).toBe(true);
    expect(Date.now() - begun).toBeLessThan(HANG_MS);
    const saved = await store.getThread(thread.id);
    expect(saved?.messages.map((message) => message.role)).toEqual(['user']);
  });
});
