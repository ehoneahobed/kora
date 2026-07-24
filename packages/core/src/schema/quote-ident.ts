/**
 * Quote a SQL identifier (table or column name) for safe interpolation into
 * generated SQL.
 *
 * Uses standard double-quote quoting, which both SQLite and PostgreSQL honor,
 * and doubles any embedded double-quote per the SQL standard. Quoting is what
 * lets a valid JavaScript identifier — camelCase (`formResponses`), PascalCase
 * (`UserProfiles`), or a word that happens to be a SQL keyword (`order`,
 * `select`) — round-trip through generated DDL and queries without ever
 * producing invalid or ambiguous SQL.
 *
 * Schema validation (see `validateCollectionName` / `validateFieldName`)
 * already restricts identifiers to `[A-Za-z][A-Za-z0-9_]*`, so the escape here
 * never actually fires in practice; it is defense in depth so this helper is
 * correct for any input rather than only for pre-validated names.
 *
 * Consistency is the contract: every path that emits an identifier for a
 * user-defined collection or field MUST go through this helper, because a
 * quoted `CREATE TABLE "order"` paired with an unquoted `SELECT ... FROM order`
 * would reintroduce the exact keyword-collision bug this guards against.
 *
 * @param name - The raw identifier (collection name, field/column name).
 * @returns The identifier wrapped in double quotes, ready to splice into SQL.
 *
 * @example
 * ```typescript
 * quoteIdent('formResponses') // => '"formResponses"'
 * quoteIdent('order')         // => '"order"'
 * ```
 */
export function quoteIdent(name: string): string {
	return `"${name.replace(/"/g, '""')}"`
}
