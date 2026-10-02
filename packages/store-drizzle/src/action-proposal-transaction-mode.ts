/** Explicitly certified drivers; unknown/synchronous drivers must never receive an async callback. */
export function actionProposalTransactionMode(
  kind: string | undefined,
): 'sync' | 'async' | 'unsupported' {
  if (kind === 'BetterSQLite3Database' || kind === 'BetterSQLiteTransaction') return 'sync';
  if (
    kind !== undefined &&
    [
      'NodePgDatabase',
      'NodePgTransaction',
      'MySql2Database',
      'MySql2Transaction',
      'LibSQLDatabase',
      'LibSQLTransaction',
    ].includes(kind)
  )
    return 'async';
  return 'unsupported';
}
