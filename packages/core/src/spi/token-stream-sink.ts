/**
 * The "data plane": live token transport, decoupled from the durable control plane.
 *
 * The model turn writes deltas to a `SinkWriter` keyed by runId; the HTTP layer
 * `subscribe`s by runId and pipes the chunks to the browser as SSE. A late subscriber
 * (reconnect/resume) replays buffered chunks first, then follows live — which is what
 * makes streaming survive a dropped connection or a pod restart.
 */
export interface SinkWriter {
  write(chunk: Uint8Array): void | Promise<void>;
  /** Mark the run's stream finished (no more chunks). */
  end(): void | Promise<void>;
}

export interface TokenStreamSink {
  /** Open (or reopen) the writer for a run. */
  open(runId: string): SinkWriter | Promise<SinkWriter>;
  /** Replay buffered chunks for the run, then yield live ones until `end()`. */
  subscribe(runId: string): AsyncIterable<Uint8Array>;
  /** Drop any buffer/resources for the run. */
  close(runId: string): void | Promise<void>;
}
