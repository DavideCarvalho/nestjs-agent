import { describe, expect, it } from 'vitest';
import { RUN_STATUS_OPTIONS } from './ReliabilitySection';

/**
 * A terminal a run can settle on that the filter does not offer is a terminal an operator cannot
 * look at: the recent-runs table is filtered server-side, and the dropdown is the only way to ask
 * for a value. `cancelled` runs were being written and were unreachable.
 */
describe('the run status filter', () => {
  it('offers every terminal a run can settle on', () => {
    expect(RUN_STATUS_OPTIONS.map((option) => option.value)).toEqual([
      '',
      'running',
      'completed',
      'failed',
      'cancelled',
    ]);
  });
});
