import { describe, expect, it } from 'vitest';
import type { OpenCodeEvent } from './client.js';
import { OpenCodeEventHub } from './event-hub.js';
import { FakeOpenCode } from './testing/fake-opencode.js';

describe('OpenCodeEventHub', () => {
  it('follows a server onto a new client for the same key', async () => {
    const hub = new OpenCodeEventHub();
    const first = new FakeOpenCode();
    const second = new FakeOpenCode();
    const heard: OpenCodeEvent[] = [];
    const stopA = await hub.listen('tenant-1', first, 'ses_1', (e) => heard.push(e));
    // The host replaced the connection (a new sandbox under the same key).
    const stopB = await hub.listen('tenant-1', second, 'ses_2', (e) => heard.push(e));

    first.emit({ type: 'session.text.delta', data: { sessionID: 'ses_1', delta: 'old' } });
    second.emit({ type: 'session.text.delta', data: { sessionID: 'ses_1', delta: 'a' } });
    second.emit({ type: 'session.text.delta', data: { sessionID: 'ses_2', delta: 'b' } });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(heard.map((e) => e.data.delta)).toEqual(['a', 'b']);
    stopA();
    stopB();
    hub.close();
  });

  it('is open once the server sent its first event, not when the stream was asked for', async () => {
    const hub = new OpenCodeEventHub();
    const fake = new FakeOpenCode();
    fake.connectDelayMs = 40;
    const heard: OpenCodeEvent[] = [];
    const started = Date.now();
    const stop = await hub.listen('tenant-1', fake, 'ses_1', (e) => heard.push(e));
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
    // What the session says right after `listen` resolves (the answer to a prompt) is heard.
    fake.emit({ type: 'session.text.delta', data: { sessionID: 'ses_1', delta: 'first' } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(heard.map((e) => e.data.delta)).toEqual(['first']);
    stop();
    hub.close();
  });

  it('goes on after the connect timeout when the server never opens the stream', async () => {
    const hub = new OpenCodeEventHub({ connectTimeoutMs: 20 });
    const fake = new FakeOpenCode();
    fake.connectDelayMs = 10_000;
    const stop = await hub.listen('tenant-1', fake, 'ses_1', () => undefined);
    stop();
    hub.close();
  });
});
