import { StepFailedError } from '@nestjs/workflows';
import { describe, expect, it } from 'vitest';
import { rebuildTurnError, stepFailureCause } from './turn-journal.js';

describe('stepFailureCause', () => {
  it("reads the journaled cause off @nestjs/workflows' StepFailedError", () => {
    const error = new StepFailedError('llm:0', 3, {
      name: 'AI_NoOutputGeneratedError',
      message: 'No output generated',
    });
    expect(stepFailureCause(error)).toEqual({
      name: 'AI_NoOutputGeneratedError',
      message: 'No output generated',
    });
  });

  it("falls back to the step error's own message when there is no cause", () => {
    const failure = stepFailureCause({ message: 'Step "llm:0" failed', cause: undefined });
    expect(failure).toEqual({ name: 'Error', message: 'Step "llm:0" failed' });
    expect(rebuildTurnError(failure)).toBeInstanceOf(Error);
  });

  it('keeps a cause that is not an error, as text, instead of throwing', () => {
    expect(stepFailureCause({ message: 'x', cause: 'socket hang up' })).toEqual({
      name: 'Error',
      message: 'socket hang up',
    });
    expect(stepFailureCause({ message: 'x', cause: { code: 503 } })).toEqual({
      name: 'Error',
      message: '{"code":503}',
    });
    expect(stepFailureCause({ message: 'x', cause: { name: 7, message: 'boom' } })).toEqual({
      name: 'Error',
      message: 'boom',
    });
  });
});
