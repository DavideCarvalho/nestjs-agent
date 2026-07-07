import {
  AgentStreamError,
  type SinkWriter,
  type StreamError,
  type TokenStreamSink,
} from '@dudousxd/nestjs-agent-core';

interface RunBuffer {
  chunks: Uint8Array[];
  ended: boolean;
  failure?: StreamError;
  notify: Set<() => void>;
}

/**
 * In-memory `TokenStreamSink`. Buffers chunks per run so a late subscriber (reconnect)
 * replays everything emitted so far, then follows live until the run ends.
 */
export class InMemoryTokenStreamSink implements TokenStreamSink {
  private readonly runs = new Map<string, RunBuffer>();

  private buffer(runId: string): RunBuffer {
    let buf = this.runs.get(runId);
    if (buf === undefined) {
      buf = { chunks: [], ended: false, notify: new Set() };
      this.runs.set(runId, buf);
    }
    return buf;
  }

  private wake(buf: RunBuffer): void {
    for (const resolve of buf.notify) {
      resolve();
    }
    buf.notify.clear();
  }

  open(runId: string): SinkWriter {
    const buf = this.buffer(runId);
    return {
      write: (chunk: Uint8Array) => {
        buf.chunks.push(chunk);
        this.wake(buf);
      },
      end: () => {
        buf.ended = true;
        this.wake(buf);
      },
      fail: (error: StreamError) => {
        buf.failure = error;
        buf.ended = true;
        this.wake(buf);
      },
    };
  }

  async *subscribe(runId: string): AsyncIterable<Uint8Array> {
    const buf = this.buffer(runId);
    let index = 0;
    while (true) {
      while (index < buf.chunks.length) {
        const chunk = buf.chunks[index];
        index += 1;
        if (chunk !== undefined) {
          yield chunk;
        }
      }
      if (buf.ended) {
        if (buf.failure !== undefined) {
          throw new AgentStreamError(buf.failure);
        }
        return;
      }
      await new Promise<void>((resolve) => buf.notify.add(resolve));
    }
  }

  close(runId: string): void {
    this.runs.delete(runId);
  }
}
