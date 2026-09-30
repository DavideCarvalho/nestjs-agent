import { RUN_NOT_ACTIVE_CODE, RUN_NOT_ACTIVE_MESSAGE } from '@dudousxd/nestjs-agent-core';
import { ConflictException } from '@nestjs/common';

/**
 * `approve` / `reject` / `answer` / `skip` addressed at a run that is no longer running — answered
 * `409 { code: 'run_not_active', message }`.
 *
 * The runtime would take the signal and buffer it for a run that never comes back: the person's
 * "yes" is accepted, the card says so, and nothing runs. Refusing it is what lets a client say so.
 */
export class RunNotActiveException extends ConflictException {
  readonly code = RUN_NOT_ACTIVE_CODE;

  constructor(readonly runId: string) {
    super({ statusCode: 409, code: RUN_NOT_ACTIVE_CODE, message: RUN_NOT_ACTIVE_MESSAGE });
  }
}
