import { describe, expect, it } from 'vitest';
import { nestjsAgentCodegen } from './index.js';

describe('nestjsAgentCodegen', () => {
  it('appends the agent routes to whatever the core discovered', () => {
    const existing = [{ method: 'GET', path: '/health', name: 'health', params: [] }];
    const out = nestjsAgentCodegen().transformRoutes(existing as never);
    // keeps the pre-existing route, then appends ours
    expect(out[0]).toMatchObject({ name: 'health' });
    const names = out.map((route) => route.name);
    expect(names).toContain('agent.threads.list');
    expect(names).toContain('agent.threads.get');
    expect(names).toContain('agent.threads.fork');
    expect(names).toContain('agent.personas');
    expect(names).toContain('agent.toolCall.approve');
    expect(names).toContain('agent.toolCall.reject');
    expect(names).toContain('agent.quota');
    expect(names).toContain('agent.chat.cancel');
  });

  it('mounts routes under /agent and honors basePath', () => {
    const out = nestjsAgentCodegen({ basePath: '/api/' }).transformRoutes([] as never);
    const list = out.find((route) => route.name === 'agent.threads.list');
    expect(list?.path).toBe('/api/agent/threads');
    const fork = out.find((route) => route.name === 'agent.threads.fork');
    expect(fork?.path).toBe('/api/agent/threads/:id/fork-from/:messageId');
    expect(fork?.params).toEqual([
      { name: 'id', source: 'path' },
      { name: 'messageId', source: 'path' },
    ]);
  });

  it('uses a custom namespace', () => {
    const out = nestjsAgentCodegen({ name: 'assistant' }).transformRoutes([] as never);
    expect(out.some((route) => route.name === 'assistant.threads.list')).toBe(true);
  });

  it('omits the streaming chat endpoints (handled by the React transport)', () => {
    const out = nestjsAgentCodegen().transformRoutes([] as never);
    expect(out.some((route) => route.path.endsWith('/agent/chat'))).toBe(false);
    expect(out.some((route) => route.path.endsWith('/stream'))).toBe(false);
  });
});
