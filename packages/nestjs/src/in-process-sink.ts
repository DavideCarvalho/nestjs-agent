import type { SinkWriter, TokenStreamSink } from '@dudousxd/nestjs-agent-core';

interface RunBuffer {
  chunks: Uint8Array[];
  ended: boolean;
  notify: Set<() => void>;
}

/**
 * The default `TokenStreamSink`: buffers chunks per run in-process so a reconnecting
 * subscriber replays everything so far, then follows live. Good for a single replica; for
 * multi-replica deployments use `@dudousxd/nestjs-agent-transport-redis`.
 */
export class InProcessTokenStreamSink implements TokenStreamSink {
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
        return;
      }
      await new Promise<void>((resolve) => buf.notify.add(resolve));
    }
  }

  close(runId: string): void {
    this.runs.delete(runId);
  }
}
