/**
 * Generates a stub operation-transform module for sync-time op log migration.
 */
export function generateOperationTransformModule(fromVersion: number, toVersion: number): string {
	return [
		"import type { Operation, OperationTransform } from '@korajs/core'",
		'',
		'/**',
		` * Operation transforms for schema v${fromVersion} → v${toVersion}.`,
		' * Implement `transform` to rewrite or drop legacy operations during sync.',
		' * @see https://korajs.dev/docs/migrations',
		' */',
		'export const operationTransforms: OperationTransform[] = [',
		'  {',
		`    fromVersion: ${fromVersion},`,
		`    toVersion: ${toVersion},`,
		'    transform(operation: Operation): Operation | null {',
		'      // Return null to drop unmigratable operations.',
		'      return operation',
		'    },',
		'  },',
		']',
		'',
	].join('\n')
}
