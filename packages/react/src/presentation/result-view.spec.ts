import { describe, expect, it } from 'vitest';
import { inferResultView, resolveResultView } from './result-view.js';

describe('resolveResultView', () => {
  const output = {
    total: 3,
    unit: 'eur',
    rows: [
      { id: 1, name: 'a' },
      { id: 2, name: null },
    ],
    lines: ['one', 'two'],
  };

  it('reads metrics, dropping the ones with nothing behind them', () => {
    expect(
      resolveResultView(output, {
        kind: 'metrics',
        fields: [
          { path: 'total', label: 'Total', unit: 'items' },
          { path: 'missing', label: 'Missing' },
        ],
      }),
    ).toEqual({ kind: 'metrics', readings: [{ label: 'Total', value: '3', unit: 'items' }] });
  });

  it('reads a table as rows of text, with an em dash for nothing', () => {
    expect(
      resolveResultView(output, {
        kind: 'table',
        rows: 'rows',
        columns: [
          { path: 'id', label: 'ID' },
          { path: 'name', label: 'Name' },
        ],
      }),
    ).toMatchObject({
      rows: [
        ['1', 'a'],
        ['2', '—'],
      ],
      empty: null,
    });
  });

  it('gives an empty table its declared line', () => {
    expect(
      resolveResultView({ rows: [] }, { kind: 'table', rows: 'rows', columns: [], empty: 'None' }),
    ).toEqual({ kind: 'table', columns: [], rows: [], empty: 'None' });
  });

  it('reads a log and a templated note', () => {
    expect(resolveResultView(output, { kind: 'log', lines: 'lines' })).toEqual({
      kind: 'log',
      lines: ['one', 'two'],
    });
    expect(resolveResultView(output, { kind: 'note', text: 'Found {total} {unit}' })).toEqual({
      kind: 'note',
      text: 'Found 3 eur',
    });
  });

  it('draws nothing for elsewhere, or with no view unless asked to infer one', () => {
    expect(resolveResultView(output, { kind: 'elsewhere' })).toBeNull();
    expect(resolveResultView(output, undefined)).toBeNull();
    expect(resolveResultView({ lines: ['x'] }, undefined, { infer: true })).toEqual({
      kind: 'log',
      lines: ['x'],
    });
  });
});

describe('inferResultView', () => {
  it('reads records as a table, strings as a log, a flat record as metrics, and gives up otherwise', () => {
    expect(inferResultView({ items: [{ a: 1, nested: { x: 1 } }] })).toEqual({
      kind: 'table',
      rows: 'items',
      columns: [{ path: 'a', label: 'a' }],
    });
    expect(inferResultView({ ok: true, n: 2 })).toEqual({
      kind: 'metrics',
      fields: [
        { path: 'ok', label: 'ok' },
        { path: 'n', label: 'n' },
      ],
    });
    expect(inferResultView('text')).toBeUndefined();
    expect(inferResultView({ deep: { x: 1 } })).toBeUndefined();
  });
});
