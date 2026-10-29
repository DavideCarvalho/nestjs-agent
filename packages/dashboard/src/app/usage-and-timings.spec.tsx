// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RunDetailPanel } from './RunDetailPanel';
import { featureUnits } from './SpendSection';
import { MOCK_RUN_DETAIL } from './mock-data';

describe('RunDetailPanel — where the time went', () => {
  it('breaks the run into queue / model / tools and lists each step', () => {
    render(
      <RunDetailPanel
        detail={{
          ...MOCK_RUN_DETAIL,
          run: { ...MOCK_RUN_DETAIL.run, durationMs: 5000, queueMs: 40 },
          timings: {
            modelMs: 3000,
            toolsMs: 1200,
            modelCalls: 2,
            toolCalls: 1,
            steps: [
              {
                step: 0,
                modelMs: 1800,
                tools: [{ toolCallId: 'c1', toolName: 'search_orders', ms: 1200 }],
                toolsMs: 1200,
              },
              { step: 1, modelMs: 1200, tools: [], toolsMs: 0 },
            ],
          },
        }}
      />,
    );
    expect(screen.getByText('Where the time went')).toBeDefined();
    expect(screen.getByText('2 model calls · 1 tool calls')).toBeDefined();
    expect(screen.getByText(/search_orders 1\.2s/)).toBeDefined();
  });

  it('leaves the panel out for a run with no timings', () => {
    render(<RunDetailPanel detail={{ ...MOCK_RUN_DETAIL, timings: null }} />);
    expect(screen.queryByText('Where the time went')).toBeNull();
  });
});

describe('featureUnits', () => {
  it('names what a feature billed, in its own units', () => {
    expect(
      featureUnits({
        feature: 'transcription',
        source: 'external',
        requests: 3,
        inputTokens: 0,
        outputTokens: 0,
        audioSeconds: 540,
        characters: 0,
        costUsd: 1.6,
      }),
    ).toBe('540 s audio');
  });
});
