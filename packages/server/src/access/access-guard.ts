import type { SchemaDefinition } from '@korajs/core'
import { SyncError } from '@korajs/core'

/**
 * DECISION (temporary, beta.15 access step 2): access rules can be declared in the
 * schema before the sync server enforces them. Until it does, a server store refuses
 * to install a schema that declares them, so no deployment ever serves those
 * collections with the rules silently ignored (every signed-in user would read and
 * write them). Removed when enforcement lands.
 *
 * @throws {SyncError} `ACCESS_RULES_NOT_ENFORCED` when the schema declares access rules
 */
export function assertAccessRulesEnforceable(
	schema: SchemaDefinition | null | undefined,
	options: { accessRulesEnforced?: boolean } = {},
): void {
	if (!schema?.access || options.accessRulesEnforced === true) return
	throw new SyncError(
		'This schema declares access rules, which this version of the sync server does not enforce yet. Remove `access` from the schema or use a Kora version that enforces it.',
		{ code: 'ACCESS_RULES_NOT_ENFORCED' },
	)
}
