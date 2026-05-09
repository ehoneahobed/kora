import { SchemaValidationError } from '../errors/errors'
import type {
	FieldDescriptor,
	SchemaDefinition,
	StateMachineConstraint,
	TransitionMap,
	TransitionValidationResult,
} from '../types'

/**
 * Validates whether a transition from one state to another is allowed
 * by the given state machine constraint.
 *
 * @param constraint - The state machine constraint defining allowed transitions
 * @param fromValue - The current state value (before the transition)
 * @param toValue - The target state value (after the transition)
 * @returns A TransitionValidationResult describing whether the transition is valid
 *
 * @example
 * ```typescript
 * const constraint: StateMachineConstraint = {
 *   field: 'status',
 *   collection: 'orders',
 *   transitions: {
 *     draft: ['submitted', 'cancelled'],
 *     submitted: ['approved'],
 *     approved: [],
 *   },
 * }
 *
 * const result = validateTransition(constraint, 'draft', 'submitted')
 * // { valid: true, from: 'draft', to: 'submitted', field: 'status',
 * //   collection: 'orders', allowedTargets: ['submitted', 'cancelled'] }
 * ```
 */
export function validateTransition(
	constraint: StateMachineConstraint,
	fromValue: unknown,
	toValue: unknown,
): TransitionValidationResult {
	const from = String(fromValue)
	const to = String(toValue)
	const allowedTargets = constraint.transitions[from] ?? []

	return {
		valid: allowedTargets.includes(to),
		from,
		to,
		field: constraint.field,
		collection: constraint.collection,
		allowedTargets,
	}
}

/**
 * Extracts all state machine constraints from a schema definition.
 * Scans every collection for enum fields that have transition rules declared
 * via the `.transitions()` builder method.
 *
 * @param schema - The schema definition to extract constraints from
 * @returns An array of StateMachineConstraint objects, one per enum field with transitions
 *
 * @example
 * ```typescript
 * const schema = defineSchema({
 *   version: 1,
 *   collections: {
 *     orders: {
 *       fields: {
 *         status: t.enum(['draft', 'submitted']).transitions({
 *           draft: ['submitted'],
 *           submitted: [],
 *         }),
 *       },
 *     },
 *   },
 * })
 *
 * const constraints = buildStateMachineConstraints(schema)
 * // [{ field: 'status', collection: 'orders', transitions: { draft: ['submitted'], submitted: [] } }]
 * ```
 */
export function buildStateMachineConstraints(schema: SchemaDefinition): StateMachineConstraint[] {
	const constraints: StateMachineConstraint[] = []

	for (const [collectionName, collection] of Object.entries(schema.collections)) {
		for (const [fieldName, descriptor] of Object.entries(collection.fields)) {
			if (descriptor.kind === 'enum' && descriptor.transitions !== null) {
				constraints.push({
					field: fieldName,
					collection: collectionName,
					transitions: descriptor.transitions,
				})
			}
		}
	}

	return constraints
}

/**
 * Finds the state machine constraint for a specific field in a specific collection,
 * if one exists.
 *
 * @param schema - The schema definition to search
 * @param collection - The collection name
 * @param field - The field name
 * @returns The TransitionMap if the field has transitions declared, or null otherwise
 */
export function getTransitionMap(
	schema: SchemaDefinition,
	collection: string,
	field: string,
): TransitionMap | null {
	const collectionDef = schema.collections[collection]
	if (!collectionDef) {
		return null
	}
	const fieldDef = collectionDef.fields[field]
	if (!fieldDef || fieldDef.kind !== 'enum') {
		return null
	}
	return fieldDef.transitions
}

/**
 * Validates a state machine definition against a collection's fields during schema building.
 * Called by defineSchema() to ensure the state machine is well-formed.
 *
 * @param collectionName - Name of the collection for error messages
 * @param sm - The state machine input definition
 * @param fields - The built field descriptors for the collection
 * @throws {SchemaValidationError} If the state machine definition is invalid
 */
export function validateStateMachineDefinition(
	collectionName: string,
	sm: { field: string; transitions: Record<string, string[]>; onInvalidTransition: string },
	fields: Record<string, FieldDescriptor>,
): void {
	const fieldDef = fields[sm.field]
	if (!fieldDef) {
		throw new SchemaValidationError(
			`State machine field "${sm.field}" does not exist in collection "${collectionName}". Available fields: ${Object.keys(fields).join(', ')}`,
			{ collection: collectionName, field: sm.field },
		)
	}
	if (fieldDef.kind !== 'enum') {
		throw new SchemaValidationError(
			`State machine field "${sm.field}" in collection "${collectionName}" must be an enum field, but got "${fieldDef.kind}"`,
			{ collection: collectionName, field: sm.field, kind: fieldDef.kind },
		)
	}
	const enumValues = fieldDef.enumValues
	if (!enumValues || enumValues.length === 0) {
		throw new SchemaValidationError(
			`State machine field "${sm.field}" in collection "${collectionName}" has no enum values defined`,
			{ collection: collectionName, field: sm.field },
		)
	}
	const validValues = new Set(enumValues)
	for (const [state, targets] of Object.entries(sm.transitions)) {
		if (!validValues.has(state)) {
			throw new SchemaValidationError(
				`State machine transition source "${state}" is not a valid enum value for field "${sm.field}" in collection "${collectionName}". Valid values: ${[...validValues].join(', ')}`,
				{ collection: collectionName, field: sm.field, state },
			)
		}
		for (const target of targets) {
			if (!validValues.has(target)) {
				throw new SchemaValidationError(
					`State machine transition target "${target}" is not a valid enum value for field "${sm.field}" in collection "${collectionName}". Valid values: ${[...validValues].join(', ')}`,
					{ collection: collectionName, field: sm.field, state, target },
				)
			}
		}
	}
	if (sm.onInvalidTransition !== 'reject' && sm.onInvalidTransition !== 'last-valid-state') {
		throw new SchemaValidationError(
			`State machine onInvalidTransition must be "reject" or "last-valid-state", got "${sm.onInvalidTransition}" in collection "${collectionName}"`,
			{ collection: collectionName, onInvalidTransition: sm.onInvalidTransition },
		)
	}
}
