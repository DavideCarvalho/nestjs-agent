/**
 * AG-UI 1.0 (https://docs.ag-ui.com/spec/1.0), producer side, framework-free: the encoder that
 * projects a run's stream onto AG-UI events, the stream driver that ends a run when it stops to
 * ask, and the readers for `RunAgentInput`. `@dudousxd/nestjs-agent` serves it as
 * `POST <path>/ag-ui` (`adapters: [agUiAdapter()]`); `@adonis-agora/agent` serves the same encoder.
 */

export { AgUiEncoder, type AgUiEncoderOptions } from './encoder.js';
export {
  type ForwardedOptions,
  type InlineMedia,
  parseRunInput,
  planResume,
  type ResumeDecision,
  type ResumePlan,
  readAnswersPayload,
  readApprovalPayload,
  readContext,
  readForwardedProps,
  readUserTurn,
  type UserTurn,
} from './input.js';
export { decodeInterruptId, encodeInterruptId, type InterruptAddress } from './interrupt-id.js';
export { type AgUiStreamOptions, agUiEvents, agUiFramesFromNdjson, agUiSse } from './stream.js';
export * from './types.js';
