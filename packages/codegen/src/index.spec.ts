import type { RouteDescriptor } from '@dudousxd/nestjs-codegen';
import { describe, expect, it } from 'vitest';
import { nestjsAgentCodegen } from './index.js';

describe('nestjsAgentCodegen', () => {
  it('appends the agent routes to whatever the core discovered', () => {
    const existing: RouteDescriptor[] = [
      { method: 'GET', path: '/health', name: 'health', params: [] },
    ];
    const out = nestjsAgentCodegen().transformRoutes(existing);
    // keeps the pre-existing route, then appends ours
    expect(out[0]).toMatchObject({ name: 'health' });
    const names = out.map((route) => route.name);
    expect(names).toContain('agent.threads.list');
    expect(names).toContain('agent.threads.get');
    expect(names).toContain('agent.threads.fork');
    expect(names).toContain('agent.toolCall.approve');
    expect(names).toContain('agent.toolCall.reject');
    expect(names).toContain('agent.quota');
    expect(names).toContain('agent.chat.cancel');
    expect(names).toContain('agent.toolCall.answer');
    expect(names).toContain('agent.toolCall.skip');
    expect(names).toContain('agent.skills.list');
    expect(names).toContain('agent.memories.list');
    expect(names).toContain('agent.memories.forget');
    expect(names).toContain('agent.attachments.list');
    // the persona catalog route was deleted along with the persona concept
    expect(names).not.toContain('agent.personas');
  });

  it('mounts routes under /agent and honors basePath', () => {
    const out = nestjsAgentCodegen({ basePath: '/api/' }).transformRoutes([]);
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
    const out = nestjsAgentCodegen({ name: 'assistant' }).transformRoutes([]);
    expect(out.some((route) => route.name === 'assistant.threads.list')).toBe(true);
  });

  it('omits the streaming chat endpoints (handled by the React transport)', () => {
    const out = nestjsAgentCodegen().transformRoutes([]);
    expect(out.some((route) => route.path.endsWith('/agent/chat'))).toBe(false);
    expect(out.some((route) => route.path.endsWith('/stream'))).toBe(false);
  });
});
