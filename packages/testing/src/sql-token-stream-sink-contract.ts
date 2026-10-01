import {
  AgentStreamError,
  type SinkWriter,
  type SqlTokenStreamSink,
  type SqlTokenStreamSinkOptions,
  type StreamError,
  type TokenStreamSink,
  encodeStreamEvent,
} from '@dudousxd/nestjs-agent-core';

/**
 * What a SQL sink under test needs: sink instances on "replicas" that share nothing but the
 * database, and two ways to look at the table directly.
 */
export interface SqlSinkContractSubject {
  /** A sink on replica `replica` (0 = A, 1 = B), with the given options over the shared table. */
  sinkOn(replica: number, options?: SqlTokenStreamSinkOptions): SqlTokenStreamSink;
  /** How many rows the table holds for the run. */
  rowCount(runId: string): Promise<number>;
  /** The run's `seq` values, ascending. */
  seqs(runId: string): Promise<number[]>;
  /** Insert a raw row (another writer, or the past): `frame: null` is a terminal row. */
  insertRow(runId: string, seq: number, frame: string | null, createdAt: number): Promise<void>;
}

/** One behaviour every SQL-backed {@link SqlTokenStreamSink} must have. `run` throws on a mismatch. */
export interface SqlSinkContractCase {
  name: string;
  run(subject: SqlSinkContractSubject, runId: string): Promise<void>;
}

function check(condition: boolean, message: string, actual?: unknown): void {
  if (!condition) {
    throw new Error(actual === undefined ? message : `${message} (got ${JSON.stringify(actual)})`);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const decoder = new TextDecoder();
const text = (value: string) => encodeStreamEvent({ kind: 'text', text: value });
const step = () => encodeStreamEvent({ kind: 'step-start' });
const ui = (id: string) => encodeStreamEvent({ kind: 'ui', id, component: 'Card', props: { id } });

/** Every line a subscription yields, until the run ends. */
async function collect(sink: TokenStreamSink, runId: string): Promise<string[]> {
  const lines: string[] = [];
  for await (const chunk of sink.subscribe(runId)) lines.push(decoder.decode(chunk).trimEnd());
  return lines;
}

const line = (chunk: Uint8Array) => decoder.decode(chunk).trimEnd();
const fast = { pollIntervalMs: 5, flushMs: 10, autoPurge: false };

/**
 * The behaviours a SQL {@link SqlTokenStreamSink} owes the chat stream, ported from
 * `adonis-agent`'s Lucid sink spec: order, cross-replica delivery, replay, coalesced text,
 * contiguous numbering under concurrent writers, the child flush, TTL purge, and failure.
 *
 * ```ts
 * for (const contractCase of SQL_TOKEN_STREAM_SINK_CONTRACT) {
 *   it(contractCase.name, () => contractCase.run(subject, `run-${crypto.randomUUID()}`));
 * }
 * ```
 */
export const SQL_TOKEN_STREAM_SINK_CONTRACT: readonly SqlSinkContractCase[] = [
  {
    name: 'yields the frames in the order they were written, then ends',
    async run({ sinkOn }, runId) {
      const sink = sinkOn(0, fast);
      const writer = sink.open(runId);
      await writer.write(text('Hello'));
      await writer.write(step());
      await writer.write(ui('c:ui:0'));
      await writer.write(text(' world'));
      await writer.end();
      const lines = await collect(sink, runId);
      const expected = [text('Hello'), step(), ui('c:ui:0'), text(' world')].map(line);
      check(JSON.stringify(lines) === JSON.stringify(expected), 'frames in order', lines);
    },
  },
  {
    name: 'serves a run written on one replica to a subscriber on another, attached before any frame',
    async run({ sinkOn }, runId) {
      const reading = collect(sinkOn(1, fast), runId);
      await sleep(20);
      const writer = sinkOn(0, fast).open(runId);
      await writer.write(text('from A'));
      await writer.write(step());
      await writer.end();
      const lines = await reading;
      check(
        JSON.stringify(lines) === JSON.stringify([line(text('from A')), line(step())]),
        'cross-replica',
        lines,
      );
    },
  },
  {
    name: 'replays everything to a late subscriber, then follows live',
    async run({ sinkOn }, runId) {
      const writer = sinkOn(0, fast).open(runId);
      await writer.write(ui('a'));
      await writer.write(ui('b'));
      const reading = collect(sinkOn(1, fast), runId);
      await sleep(20);
      await writer.write(ui('c'));
      await writer.end();
      const lines = await reading;
      check(lines.length === 3 && lines[2] === line(ui('c')), 'replay then live', lines);
    },
  },
  {
    name: 'replays a failed run, then throws its AgentStreamError',
    async run({ sinkOn }, runId) {
      const writer: SinkWriter = sinkOn(0, fast).open(runId);
      await writer.write(text('all of it'));
      await writer.fail({ code: 'run_failed', message: 'boom' } satisfies StreamError);
      const lines: string[] = [];
      let failure: unknown;
      try {
        for await (const chunk of sinkOn(1, fast).subscribe(runId)) lines.push(line(chunk));
      } catch (error) {
        failure = error;
      }
      check(lines.length === 1 && lines[0] === line(text('all of it')), 'replayed', lines);
      check(
        failure instanceof AgentStreamError && failure.code === 'run_failed',
        'failure thrown',
        String(failure),
      );
    },
  },
  {
    name: 'coalesces streamed tokens into few rows without changing the text or the order',
    async run({ sinkOn, rowCount }, runId) {
      const writer = sinkOn(0, { ...fast, flushMs: 40 }).open(runId);
      const tokens = Array.from({ length: 60 }, (_, index) => `t${index} `);
      for (const token of tokens.slice(0, 30)) await writer.write(text(token));
      await writer.write(step());
      for (const token of tokens.slice(30)) await writer.write(text(token));
      await writer.end();
      const lines = await collect(sinkOn(1, fast), runId);
      const expected = [
        text(tokens.slice(0, 30).join('')),
        step(),
        text(tokens.slice(30).join('')),
      ];
      check(JSON.stringify(lines) === JSON.stringify(expected.map(line)), 'coalesced', lines);
      // Two text rows, the step and the end marker — not sixty-two.
      check((await rowCount(runId)) === 4, 'rows', await rowCount(runId));
    },
  },
  {
    name: 'writes gathered text on its own once the flush window passes',
    async run({ sinkOn, rowCount }, runId) {
      const sink = sinkOn(0, { ...fast, flushMs: 10 });
      const writer = sink.open(runId);
      await writer.write(text('a'));
      await writer.write(text('b'));
      check((await rowCount(runId)) === 0, 'nothing yet');
      await sleep(80);
      check((await rowCount(runId)) === 1, 'one row after the window', await rowCount(runId));
      await writer.end();
      const lines = await collect(sink, runId);
      check(JSON.stringify(lines) === JSON.stringify([line(text('ab'))]), 'joined', lines);
    },
  },
  {
    name: 'writes every frame as its own row under flushMs: 0',
    async run({ sinkOn }, runId) {
      const sink = sinkOn(0, { ...fast, flushMs: 0 });
      const writer = sink.open(runId);
      await writer.write(text('a'));
      await writer.write(text('b'));
      await writer.end();
      const lines = await collect(sink, runId);
      check(lines.length === 2, 'two rows', lines);
    },
  },
  {
    name: 'keeps the numbering contiguous when two replicas write into one run at once',
    async run({ sinkOn, seqs }, runId) {
      const a = sinkOn(0, { ...fast, flushMs: 0 }).open(runId);
      const b = sinkOn(1, { ...fast, flushMs: 0 }).open(runId);
      await Promise.all(
        Array.from({ length: 20 }, (_, index) => (index % 2 === 0 ? a : b).write(ui(`u${index}`))),
      );
      await a.end();
      const numbers = await seqs(runId);
      check(
        JSON.stringify(numbers) === JSON.stringify(Array.from({ length: 21 }, (_, i) => i + 1)),
        'contiguous seq',
        numbers,
      );
      const lines = await collect(sinkOn(1, fast), runId);
      check(new Set(lines).size === 20, 'every frame once', lines.length);
    },
  },
  {
    name: "writes out a delegated run's gathered text on flush(), before its parent's next frame",
    async run({ sinkOn }, runId) {
      const child = sinkOn(1, { ...fast, flushMs: 5000 }).open(runId);
      await child.write(text('from the delegate'));
      await child.flush?.();
      const parent = sinkOn(0, fast).open(runId);
      await parent.write(step());
      await parent.end();
      const lines = await collect(sinkOn(0, fast), runId);
      check(
        JSON.stringify(lines) === JSON.stringify([line(text('from the delegate')), line(step())]),
        'child text first',
        lines,
      );
    },
  },
  {
    name: 'shares gathered text between writers of one run in a process',
    async run({ sinkOn }, runId) {
      const sink = sinkOn(0, { ...fast, flushMs: 5000 });
      await sink.open(runId).write(text('first'));
      const second = sink.open(runId);
      await second.write(step());
      await second.end();
      const lines = await collect(sink, runId);
      check(
        JSON.stringify(lines) === JSON.stringify([line(text('first')), line(step())]),
        'order',
        lines,
      );
    },
  },
  {
    name: 'reports whether it holds anything for a run, and close() drops it',
    async run({ sinkOn, rowCount }, runId) {
      const sink = sinkOn(0, fast);
      check((await sink.has(runId)) === false, 'nothing yet');
      const writer = sink.open(runId);
      await writer.write(step());
      check((await sinkOn(1, fast).has(runId)) === true, 'seen from the other replica');
      await writer.end();
      await sink.close(runId);
      check((await sink.has(runId)) === false, 'closed');
      check((await rowCount(runId)) === 0, 'no rows left');
    },
  },
  {
    name: 'purges runs whose last write is older than the TTL — ended or not — and keeps the rest',
    async run({ sinkOn, insertRow }, runId) {
      const sink = sinkOn(0, { ...fast, ttlSeconds: 60 });
      const ended = `${runId}-ended`;
      const crashed = `${runId}-crashed`;
      const endedWriter = sink.open(ended);
      await endedWriter.write(step());
      await endedWriter.end();
      await sink.open(crashed).write(step());
      check((await sink.purgeExpired(Date.now() + 30_000)) === 0, 'nothing lapsed yet');
      const live = `${runId}-live`;
      await insertRow(live, 1, line(step()), Date.now() + 90_000);
      const purged = await sinkOn(1, { ...fast, ttlSeconds: 60 }).purgeExpired(
        Date.now() + 120_000,
      );
      check(purged === 2, 'purged', purged);
      check((await sink.has(ended)) === false, 'ended run gone');
      check((await sink.has(crashed)) === false, 'crashed run gone');
      check((await sink.has(live)) === true, 'live run kept');
    },
  },
  {
    name: 'never purges under ttlSeconds: 0',
    async run({ sinkOn }, runId) {
      const sink = sinkOn(0, { ...fast, ttlSeconds: 0 });
      const writer = sink.open(runId);
      await writer.write(step());
      await writer.end();
      check((await sink.purgeExpired(Date.now() + 10 * 365 * 86_400_000)) === 0, 'no purge');
      check((await sink.has(runId)) === true, 'kept');
    },
  },
  {
    name: 'purges on its own after a run ends when autoPurge is on',
    async run({ sinkOn, insertRow }, runId) {
      const sink = sinkOn(0, { ...fast, ttlSeconds: 60, autoPurge: true });
      await insertRow(`${runId}-stale`, 1, null, Date.now() - 120_000);
      await sink.open(runId).end();
      for (let tries = 0; tries < 100 && (await sink.has(`${runId}-stale`)); tries += 1) {
        await sleep(5);
      }
      check((await sink.has(`${runId}-stale`)) === false, 'stale run purged');
      check((await sink.has(runId)) === true, 'this run kept');
    },
  },
];
