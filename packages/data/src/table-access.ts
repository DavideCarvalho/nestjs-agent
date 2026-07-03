/**
 * Decides whether a role may read a given table at all. This is the coarse,
 * table-level gate; per-row scoping (see `TenantScopeRewriter`) is a separate
 * layer applied at query time.
 *
 * Domain-agnostic: the host app supplies the role→group and group→table maps.
 */
export interface TableAccessPolicy {
  /** True iff any of the caller's `roles` is permitted to read `table`. Fail-closed by contract. */
  canAccess(roles: readonly string[], table: string): boolean;
}

/** Inputs for {@link GroupTableAccessPolicy}: roles map to groups, groups to tables. */
export interface GroupTableAccessConfig {
  /** Role name → the table groups that role may read. */
  roleGroups: Record<string, string[]>;
  /**
   * Group name → the tables in that group. Entries are exact table names or
   * `prefix_*` patterns (e.g. `pribuy_*`).
   */
  tablesByGroup: Record<string, string[]>;
}

/**
 * Two-layer, data-driven table allowlist:
 *
 *   1. Every table is classified into a group (`tablesByGroup`).
 *   2. Every role lists the groups it can read (`roleGroups`).
 *
 * `canAccess(roles, table)` is then "is the table's group in ANY of the roles'
 * group lists?". **Fail-closed:** an unclassified table, unknown roles, or an
 * empty role set is denied — a forgotten table never accidentally leaks.
 */
export class GroupTableAccessPolicy implements TableAccessPolicy {
  private readonly roleGroups: Record<string, string[]>;
  private readonly tablesByGroup: Record<string, string[]>;

  constructor(config: GroupTableAccessConfig) {
    this.roleGroups = config.roleGroups;
    this.tablesByGroup = config.tablesByGroup;
  }

  canAccess(roles: readonly string[], table: string): boolean {
    const group = this.resolveGroup(table);
    if (group === undefined) return false;

    return roles.some((role) => this.roleGroups[role]?.includes(group) ?? false);
  }

  /** Resolve a table to its group, or `undefined` if unclassified (fail-closed). */
  private resolveGroup(table: string): string | undefined {
    for (const [group, patterns] of Object.entries(this.tablesByGroup)) {
      for (const pattern of patterns) {
        if (matchesPattern(table, pattern)) return group;
      }
    }
    return undefined;
  }
}

function matchesPattern(table: string, pattern: string): boolean {
  if (pattern.endsWith('*')) {
    return table.startsWith(pattern.slice(0, -1));
  }
  return table === pattern;
}
