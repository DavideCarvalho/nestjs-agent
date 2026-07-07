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
  /**
   * Terminate the run's stream with an error instead of a normal end. Subscribers replay any
   * buffered chunks first, then throw an {@link AgentStreamError} carrying this `code`/`message`
   * — so the transport can surface a typed failure frame instead of leaking it as assistant text.
   */
  fail(error: StreamError): void | Promise<void>;
}

/** A machine-readable stream failure. `code` is a stable slug; `message` is human-facing. */
export interface StreamError {
  code: string;
  message: string;
}

/**
 * Thrown out of {@link TokenStreamSink.subscribe} when a run ended via {@link SinkWriter.fail}.
 * Carries the structured {@link StreamError} so the HTTP layer can emit an `event: error` frame.
 */
export class AgentStreamError extends Error {
  readonly code: string;
  constructor(error: StreamError) {
    super(error.message);
    this.name = 'AgentStreamError';
    this.code = error.code;
  }
}

export interface TokenStreamSink {
  /** Open (or reopen) the writer for a run. */
  open(runId: string): SinkWriter | Promise<SinkWriter>;
  /**
   * Replay buffered chunks for the run, then yield live ones until `end()`. Throws
   * {@link AgentStreamError} if the run was terminated with {@link SinkWriter.fail}.
   */
  subscribe(runId: string): AsyncIterable<Uint8Array>;
  /** Drop any buffer/resources for the run. */
  close(runId: string): void | Promise<void>;
}
