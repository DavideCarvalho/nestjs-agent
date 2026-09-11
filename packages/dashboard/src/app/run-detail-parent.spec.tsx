// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RunDetailPanel } from './RunDetailPanel';
import { MOCK_RUN_DETAIL } from './mock-data';

/**
 * A delegated run's parent is on the row, and the drill-down is where an operator is standing when
 * they ask "what asked for this?". A detached child makes the question unanswerable anywhere else:
 * it outlives the turn that started it, so the transcript holds no link back.
 */
describe('RunDetailPanel — the run that asked for this one', () => {
  it('names the parent run when there is one', () => {
    render(
      <RunDetailPanel
        detail={{ ...MOCK_RUN_DETAIL, run: { ...MOCK_RUN_DETAIL.run, parentRunId: 'r-parent' } }}
      />,
    );

    expect(screen.getByText('r-parent')).toBeDefined();
  });

  it('says nothing at all for a turn nobody delegated', () => {
    render(
      <RunDetailPanel
        detail={{ ...MOCK_RUN_DETAIL, run: { ...MOCK_RUN_DETAIL.run, parentRunId: null } }}
      />,
    );

    expect(screen.queryByText(/delegated by/i)).toBeNull();
  });
});
