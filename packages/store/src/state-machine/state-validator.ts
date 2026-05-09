import { KoraError, validateTransition } from '@korajs/core'
import type {
	CollectionDefinition,
	StateMachineConstraint,
	StateMachineDefinition,
} from '@korajs/core'

/**
 * Error thrown when a local mutation attempts an invalid state transition.
 *
 * Contains enough context to debug without reproduction:
 * the collection, record, field, current state, attempted state, and allowed transitions.
 */
export class InvalidStateTransitionError extends KoraError {
	constructor(
		public readonly collection: string,
		public readonly recordId: string,
		public readonly field: string,
		public readonly fromState: string,
		public readonly toState: string,
		public readonly allowedStates: string[],
	) {
		super(
			`Invalid state transition in collection "${collection}": ` +
				`cannot transition field "${field}" from "${fromState}" to "${toState}". ` +
				`Allowed transitions from "${fromState}": ${allowedStates.length > 0 ? allowedStates.join(', ') : '(none -- terminal state)'}`,
			'INVALID_STATE_TRANSITION',
			{ collection, recordId, field, fromState, toState, allowedStates },
		)
		this.name = 'InvalidStateTransitionError'
	}
}

/**
 * Validates a state machine transition for a local mutation (insert or update).
 *
 * For inserts: validates that the initial state (from the data or the default value)
 * is a known state in the state machine.
 *
 * For updates: looks up the current state field value and checks whether
 * the transition to the new value is allowed.
 *
 * @param collectionName - Name of the collection
 * @param recordId - The record being mutated
 * @param stateMachine - The state machine definition
 * @param currentState - The current value of the state field (null for inserts)
 * @param newState - The new value being set for the state field
 * @returns An object indicating whether the transition is valid, and if not, the allowed states.
 *          When `onInvalidTransition` is 'last-valid-state', callers should suppress the field update
 *          rather than throwing.
 */
export function validateStateTransition(
	collectionName: string,
	recordId: string,
	stateMachine: StateMachineDefinition,
	currentState: string | null,
	newState: string,
): { valid: boolean; allowedStates: string[] } {
	// For inserts, any valid enum value is acceptable as the initial state
	// (schema validation already ensures the value is a valid enum value)
	if (currentState === null) {
		return { valid: true, allowedStates: [] }
	}

	// Same-state transitions are always valid (idempotent updates)
	if (currentState === newState) {
		return { valid: true, allowedStates: stateMachine.transitions[currentState] ?? [] }
	}

	const constraint: StateMachineConstraint = {
		field: stateMachine.field,
		collection: collectionName,
		transitions: stateMachine.transitions,
	}
	const transitionResult = validateTransition(constraint, currentState, newState)
	if (transitionResult.valid) {
		return { valid: true, allowedStates: transitionResult.allowedTargets }
	}

	const allowedStates = transitionResult.allowedTargets

	if (stateMachine.onInvalidTransition === 'reject') {
		throw new InvalidStateTransitionError(
			collectionName,
			recordId,
			stateMachine.field,
			currentState,
			newState,
			allowedStates,
		)
	}

	// 'last-valid-state': return invalid so the caller can suppress the field update
	return { valid: false, allowedStates }
}

/**
 * Checks whether a collection update data object contains a change to the state machine field,
 * and if so, validates the transition.
 *
 * If the state field is not in the update data, returns the data unchanged.
 * If the transition is invalid and mode is 'last-valid-state', removes the field from the data.
 * If the transition is invalid and mode is 'reject', throws InvalidStateTransitionError.
 *
 * @param collectionName - Name of the collection
 * @param recordId - The record being updated
 * @param collectionDef - The collection definition from the schema
 * @param currentRecord - The current record data (must include the state field)
 * @param updateData - The partial update data
 * @returns The update data, potentially with the state field removed if invalid and mode is 'last-valid-state'
 */
export function validateUpdateStateMachine(
	collectionName: string,
	recordId: string,
	collectionDef: CollectionDefinition,
	currentRecord: Record<string, unknown>,
	updateData: Record<string, unknown>,
): Record<string, unknown> {
	const stateMachine = collectionDef.stateMachine
	if (stateMachine === undefined) {
		return updateData
	}

	const stateField = stateMachine.field
	if (!(stateField in updateData)) {
		// State field not being changed -- no validation needed
		return updateData
	}

	const currentState = currentRecord[stateField]
	const newState = updateData[stateField]

	// Both values must be strings for state machine validation
	if (typeof currentState !== 'string' || typeof newState !== 'string') {
		return updateData
	}

	const result = validateStateTransition(
		collectionName,
		recordId,
		stateMachine,
		currentState,
		newState,
	)

	if (result.valid) {
		return updateData
	}

	// Mode is 'last-valid-state': silently remove the state field from the update
	const filtered = { ...updateData }
	delete filtered[stateField]

	// If no fields remain after removing the state field, the update becomes a no-op.
	// Return the empty object -- the caller can decide whether to proceed.
	return filtered
}
