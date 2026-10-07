import { expect, it } from 'vitest';
import { actionProposalTransactionMode } from './action-proposal-transaction-mode.js';
it.each([
  'D1Database',
  'NeonHttpDatabase',
  'BaseSQLiteDatabase',
  'SqliteRemoteDatabase',
  'BunSQLiteDatabase',
  'unrecognized',
])(
  'refuses independent admission on uncertified %s rather than committing asynchronous work early',
  (kind) => {
    expect(actionProposalTransactionMode(kind)).toBe('unsupported');
  },
);
it('executes BetterSQLite callbacks synchronously including caller transactions', () => {
  expect(actionProposalTransactionMode('BetterSQLite3Database')).toBe('sync');
  expect(actionProposalTransactionMode('BetterSQLiteTransaction')).toBe('sync');
});
it.each([
  'NodePgDatabase',
  'NodePgTransaction',
  'MySql2Database',
  'MySql2Transaction',
  'LibSQLDatabase',
  'LibSQLTransaction',
  'PostgresJsDatabase',
  'PostgresJsTransaction',
])('uses awaited transactional admission for %s', (kind) => {
  expect(actionProposalTransactionMode(kind)).toBe('async');
});
