import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

const BASE = 'http://localhost:3000';
const HEADERS = { 'content-type': 'application/json', 'x-actor-id': 'davi', 'x-actor-role': 'ADMIN' };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Meta {
  runId: string;
  threadId: string;
}

async function consumeStream(
  res: Response,
  handlers: { onMeta?: (meta: Meta) => void; onDelta?: (delta: string) => void },
): Promise<void> {
  const reader = res.body?.getReader();
  if (reader === undefined) {
    return;
  }
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      return;
    }
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = 'message';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) {
          event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          data += line.slice(5).trim();
        }
      }
      if (event === 'meta') {
        handlers.onMeta?.(JSON.parse(data) as Meta);
      } else if (event === 'done') {
        return;
      } else if (data.length > 0) {
        const parsed = JSON.parse(data) as { delta?: string };
        if (parsed.delta !== undefined) {
          handlers.onDelta?.(parsed.delta);
        }
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
}

async function chat(
  message: string,
  handlers: { onMeta?: (meta: Meta) => void; onDelta?: (delta: string) => void },
): Promise<void> {
  const res = await fetch(`${BASE}/agent/chat`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ message }),
  });
  await consumeStream(res, handlers);
}

function findPendingToolCall(thread: {
  messages: { role: string; toolCalls?: { id: string; name: string }[] }[];
}): { id: string; name: string } | undefined {
  for (let i = thread.messages.length - 1; i >= 0; i -= 1) {
    const message = thread.messages[i];
    if (message?.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      return message.toolCalls[0];
    }
  }
  return undefined;
}

async function run(): Promise<void> {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(' Scenario 1 — read tool (auto-executed, no approval)');
  console.log('══════════════════════════════════════════════════════════════');
  process.stdout.write(' user>      What is the weather in Recife?\n assistant> ');
  await chat('What is the weather in Recife?', { onDelta: (d) => process.stdout.write(d) });
  process.stdout.write('\n');

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(' Scenario 2 — action tool (durable run SUSPENDS for HITL approval)');
  console.log('══════════════════════════════════════════════════════════════');
  process.stdout.write(' user>      Please purge the app cache\n assistant> ');
  let meta: Meta | undefined;
  const streaming = chat('Please purge the app cache', {
    onMeta: (m) => {
      meta = m;
    },
    onDelta: (d) => process.stdout.write(d),
  });

  while (meta === undefined) {
    await sleep(10);
  }
  await sleep(400); // let the run reach the approval gate and persist the pending tool call
  const thread = (await (
    await fetch(`${BASE}/agent/threads/${meta.threadId}`, { headers: HEADERS })
  ).json()) as { messages: { role: string; toolCalls?: { id: string; name: string }[] }[] };
  const pending = findPendingToolCall(thread);

  process.stdout.write(`\n [human]    run is suspended on a durable signal. approving "${pending?.name}" ...\n assistant> `);
  await fetch(`${BASE}/agent/tool-call/approve`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ runId: meta.runId, toolCallId: pending?.id }),
  });
  await streaming;
  process.stdout.write('\n');

  const quota = (await (await fetch(`${BASE}/agent/quota/today`, { headers: HEADERS })).json()) as {
    usedTokens: number;
  };
  const threads = (await (await fetch(`${BASE}/agent/threads`, { headers: HEADERS })).json()) as unknown[];
  console.log('\n──────────────────────────────────────────────────────────────');
  console.log(` quota today: ${quota.usedTokens} tokens · threads: ${threads.length}`);
  console.log(' (the 📡 lines above are the aviary:agent:* diagnostics channel)');
  console.log('──────────────────────────────────────────────────────────────\n');
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: ['warn', 'error'] });
  await app.listen(3000);
  try {
    await run();
  } finally {
    await app.close();
  }
}

void bootstrap();
