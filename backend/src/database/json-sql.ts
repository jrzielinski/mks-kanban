/**
 * Cross-dialect JSON SQL fragments.
 *
 * The JSON columns (entities use `simple-json`, stored as TEXT on both
 * drivers) are occasionally queried in raw `andWhere(...)` clauses.
 * Postgres and SQLite expose completely different JSON operators, so
 * those clauses go through these helpers instead of hard-coding one
 * dialect.
 *
 *   Postgres → cast TEXT to jsonb, use jsonb_array_elements / ->>
 *   SQLite   → json_each / json_extract (json1, built into better-sqlite3)
 */
import { isSqlite } from './column-types';

/**
 * Predicate: the JSON-array column contains a scalar equal to `:param`.
 * e.g. member_ids contains :memberId
 */
export function jsonArrayContains(column: string, param: string): string {
  return isSqlite
    ? `EXISTS (SELECT 1 FROM json_each(${column}) WHERE value = :${param})`
    : `EXISTS (SELECT 1 FROM jsonb_array_elements_text(${column}::jsonb) AS je(value) WHERE je.value = :${param})`;
}

/**
 * Predicate: the JSON column is an array of objects and at least one
 * object's `key` field equals `:param`.
 * e.g. labels contains an entry whose .color = :labelColor
 */
export function jsonArrayObjectFieldEquals(column: string, key: string, param: string): string {
  return isSqlite
    ? `EXISTS (SELECT 1 FROM json_each(${column}) WHERE json_extract(value, '$.${key}') = :${param})`
    : `EXISTS (SELECT 1 FROM jsonb_array_elements(${column}::jsonb) AS je(value) WHERE je.value->>'${key}' = :${param})`;
}

/** Expression: length of the JSON-array column. */
export function jsonArrayLength(column: string): string {
  return isSqlite
    ? `json_array_length(${column})`
    : `jsonb_array_length(${column}::jsonb)`;
}

/** Expression: value of `key` inside a JSON-object column (as text). */
export function jsonField(column: string, key: string): string {
  return isSqlite
    ? `json_extract(${column}, '$.${key}')`
    : `(${column}::jsonb ->> '${key}')`;
}
