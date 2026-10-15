import type { Transaction } from '../db/transaction.ts';

/** Optional display metadata never substitutes for an identity or an authorization field. */
export function optionalDisplayText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** A read-only capability check keeps retained pre-metadata synthetic databases usable without migrating them. */
export function hasDisplayColumn(tx: Transaction, table: 'users'|'courses'|'assignments', column: 'display_name'|'name'|'display_title'): boolean {
  return Boolean(tx.get('SELECT name FROM pragma_table_info(?) WHERE name=?', table, column));
}
