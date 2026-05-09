import type { SchemaDefinition } from '@korajs/core'
import type { TestDevice } from './test-device'

/**
 * Result of a convergence check.
 */
export interface ConvergenceResult {
	/** Whether all devices have converged to the same state */
	converged: boolean
	/** Per-collection comparison details (only populated on failure) */
	differences: CollectionDifference[]
}

/**
 * Describes a difference in a collection between devices.
 */
export interface CollectionDifference {
	collection: string
	deviceA: string
	deviceB: string
	/** Records present in deviceA but not deviceB */
	missingInB: string[]
	/** Records present in deviceB but not deviceA */
	missingInA: string[]
	/** Records present in both but with different values */
	fieldDifferences: FieldDifference[]
}

/**
 * A specific field-level difference between two devices.
 */
export interface FieldDifference {
	recordId: string
	field: string
	valueInA: unknown
	valueInB: unknown
}

/**
 * Assert that all devices have converged to identical collection states.
 *
 * Compares every collection across all device pairs. Throws an error
 * with detailed diagnostics if any differences are found.
 *
 * @param devices - The devices to check for convergence
 * @param schema - The schema (used to enumerate collections)
 *
 * @example
 * ```typescript
 * await deviceA.sync()
 * await deviceB.sync()
 * await expectConverged([deviceA, deviceB], schema)
 * ```
 */
export async function expectConverged(
	devices: TestDevice[],
	schema: SchemaDefinition,
): Promise<void> {
	if (devices.length < 2) return

	const result = await checkConvergence(devices, schema)
	if (!result.converged) {
		const details = result.differences
			.map((d) => {
				const parts: string[] = [
					`  Collection "${d.collection}" differs between ${d.deviceA} and ${d.deviceB}:`,
				]
				if (d.missingInB.length > 0) {
					parts.push(`    Missing in ${d.deviceB}: ${d.missingInB.join(', ')}`)
				}
				if (d.missingInA.length > 0) {
					parts.push(`    Missing in ${d.deviceA}: ${d.missingInA.join(', ')}`)
				}
				for (const fd of d.fieldDifferences) {
					parts.push(
						`    Record "${fd.recordId}" field "${fd.field}": ${JSON.stringify(fd.valueInA)} vs ${JSON.stringify(fd.valueInB)}`,
					)
				}
				return parts.join('\n')
			})
			.join('\n')

		throw new Error(`Devices have not converged:\n${details}`)
	}
}

/**
 * Check whether all devices have converged without throwing.
 *
 * @param devices - The devices to check
 * @param schema - The schema (for collection enumeration)
 * @returns Convergence result with details
 */
export async function checkConvergence(
	devices: TestDevice[],
	schema: SchemaDefinition,
): Promise<ConvergenceResult> {
	const differences: CollectionDifference[] = []
	const collectionNames = Object.keys(schema.collections)

	for (let i = 0; i < devices.length - 1; i++) {
		for (let j = i + 1; j < devices.length; j++) {
			const deviceA = devices[i] as TestDevice
			const deviceB = devices[j] as TestDevice

			for (const collection of collectionNames) {
				const stateA = await deviceA.getState(collection)
				const stateB = await deviceB.getState(collection)

				const diff = compareCollectionStates(collection, deviceA.name, deviceB.name, stateA, stateB)

				if (diff) {
					differences.push(diff)
				}
			}
		}
	}

	return {
		converged: differences.length === 0,
		differences,
	}
}

/**
 * Compare two collection states and return differences if any.
 */
function compareCollectionStates(
	collection: string,
	nameA: string,
	nameB: string,
	stateA: Record<string, unknown>[],
	stateB: Record<string, unknown>[],
): CollectionDifference | null {
	const mapA = new Map(stateA.map((r) => [r.id as string, r]))
	const mapB = new Map(stateB.map((r) => [r.id as string, r]))

	const missingInB: string[] = []
	const missingInA: string[] = []
	const fieldDifferences: FieldDifference[] = []

	// Check records in A
	for (const [id, recordA] of mapA) {
		const recordB = mapB.get(id)
		if (!recordB) {
			missingInB.push(id)
			continue
		}

		// Compare fields (skip internal fields like _created_at, _updated_at)
		const allFields = new Set([
			...Object.keys(recordA).filter((k) => !k.startsWith('_')),
			...Object.keys(recordB).filter((k) => !k.startsWith('_')),
		])

		for (const field of allFields) {
			if (field === 'id') continue
			const valA = recordA[field]
			const valB = recordB[field]
			if (!deepEqual(valA, valB)) {
				fieldDifferences.push({
					recordId: id,
					field,
					valueInA: valA,
					valueInB: valB,
				})
			}
		}
	}

	// Check records only in B
	for (const id of mapB.keys()) {
		if (!mapA.has(id)) {
			missingInA.push(id)
		}
	}

	if (missingInB.length === 0 && missingInA.length === 0 && fieldDifferences.length === 0) {
		return null
	}

	return {
		collection,
		deviceA: nameA,
		deviceB: nameB,
		missingInB,
		missingInA,
		fieldDifferences,
	}
}

/**
 * Deep equality check for comparing field values.
 */
function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true
	if (a === null || b === null) return false
	if (a === undefined || b === undefined) return false
	if (typeof a !== typeof b) return false

	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false
		return a.every((val, i) => deepEqual(val, b[i]))
	}

	if (typeof a === 'object' && typeof b === 'object') {
		const keysA = Object.keys(a as Record<string, unknown>)
		const keysB = Object.keys(b as Record<string, unknown>)
		if (keysA.length !== keysB.length) return false
		return keysA.every((key) =>
			deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
		)
	}

	return false
}
