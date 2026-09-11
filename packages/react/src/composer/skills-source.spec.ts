import { describe, expect, it, vi } from 'vitest';
import { AgentClient } from '../client.js';
import { findActiveTrigger } from './model.js';
import { type SkillSuggestionData, createSkillsSource } from './skills-source.js';

/** As the endpoint answers: most specific scope first, then alphabetical. `shadows` only on a clash. */
const CATALOG = [
  {
    name: 'normalize-unit',
    description: 'Normalise a unit designation to DPAS form.',
    scope: 'tenant:base-7',
    shadows: ['global'],
  },
  { name: 'work-order', description: 'Open and route a work order.', scope: 'global' },
];

function clientReturning(entries: unknown = CATALOG) {
  const fetchMock = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify(entries), {
        headers: { 'content-type': 'application/json' },
      }),
  );
  const client = new AgentClient({ fetch: fetchMock });
  return { client, fetchMock };
}

const NO_SIGNAL = new AbortController().signal;

describe('createSkillsSource', () => {
  it('reads the scope-resolved catalog and keeps each skill’s provenance', async () => {
    const { client, fetchMock } = clientReturning();
    const source = createSkillsSource({ client });

    const items = await source.getItems('', NO_SIGNAL);

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/agent/skills');
    expect(items).toEqual([
      {
        id: 'normalize-unit',
        label: 'normalize-unit',
        description: 'Normalise a unit designation to DPAS form.',
        // A clash is said out loud: "there is no org default" and "there is one and mine wins"
        // are different facts, and only one of them is worth a user's attention.
        hint: 'tenant:base-7 · overrides global',
        data: { scope: 'tenant:base-7', shadows: ['global'] },
      },
      {
        id: 'work-order',
        label: 'work-order',
        description: 'Open and route a work order.',
        hint: 'global',
        data: { scope: 'global' },
      },
    ]);
    expect((items[0]?.data as SkillSuggestionData).shadows).toEqual(['global']);
  });

  it('leaves the order alone, because the order is the precedence', async () => {
    // Deliberately NOT alphabetical: the endpoint orders by scope first, so a client that re-sorted
    // by name would hide which scope won.
    const { client } = clientReturning([
      { name: 'work-order', description: 'Open and route a work order.', scope: 'tenant:base-7' },
      { name: 'normalize-unit', description: 'Normalise a unit designation.', scope: 'global' },
    ]);
    const source = createSkillsSource({ client });

    const items = await source.getItems('', NO_SIGNAL);

    expect(items.map((item) => item.id)).toEqual(['work-order', 'normalize-unit']);
  });

  it('is a command trigger: the first character of the line, and nowhere else', () => {
    const { client } = clientReturning();
    const sources = [createSkillsSource({ client })];

    expect(findActiveTrigger('/dep', 4, sources)).toMatchObject({ query: 'dep' });
    expect(findActiveTrigger('src/foo', 7, sources)).toBeNull();
    // Not even after a space — a mention would open here, a command does not.
    expect(findActiveTrigger('please /deploy', 14, sources)).toBeNull();
  });

  it('reads once per thread and lets the local filter do the narrowing', async () => {
    const { client, fetchMock } = clientReturning();
    const source = createSkillsSource({ client });

    await source.getItems('d', NO_SIGNAL);
    await source.getItems('de', NO_SIGNAL);
    await source.getItems('dep', NO_SIGNAL);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads the thread id at query time, so a thread created mid-chat is picked up', async () => {
    const { client, fetchMock } = clientReturning();
    const chat: { threadId?: string } = {};
    const source = createSkillsSource({ client, getThreadId: () => chat.threadId });

    await source.getItems('', NO_SIGNAL);
    chat.threadId = 'thr-1';
    await source.getItems('', NO_SIGNAL);

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/agent/skills',
      '/agent/skills?threadId=thr-1',
    ]);
  });

  it('retries after a failed read instead of caching the outage', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(
        new Response(JSON.stringify(CATALOG), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    const client = new AgentClient({ fetch: fetchMock });
    const source = createSkillsSource({ client });

    await expect(source.getItems('', NO_SIGNAL)).rejects.toThrow('offline');
    await expect(source.getItems('', NO_SIGNAL)).resolves.toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
