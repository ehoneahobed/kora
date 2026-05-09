import type {
	CollectionDefinition,
	HLCTimestamp,
	Operation,
	StateMachineDefinition,
} from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { isStateMachineField, resolveStateMachineMerge } from './state-machine-constraint'

const stateMachine: StateMachineDefinition = {
	field: 'status',
	transitions: {
		draft: ['pending', 'cancelled'],
		pending: ['confirmed', 'cancelled'],
		confirmed: ['shipped', 'cancelled'],
		shipped: ['delivered'],
		delivered: [],
		cancelled: [],
	},
	onInvalidTransition: 'reject',
}

function makeOp(data: Record<string, unknown> | null, nodeId: string, wallTime: number): Operation {
	return {
		id: `op-${nodeId}-${wallTime}`,
		nodeId,
		type: 'update',
		collection: 'orders',
		recordId: 'rec-1',
		data,
		previousData: null,
		timestamp: { wallTime, logical: 0, nodeId },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
	}
}

describe('resolveStateMachineMerge', () => {
	test('concurrent valid transitions: LWW resolves (local wins)', () => {
		const localOp = makeOp({ status: 'confirmed' }, 'node-a', 2000)
		const remoteOp = makeOp({ status: 'cancelled' }, 'node-b', 1000)
		const baseState = { status: 'pending' }

		const result = resolveStateMachineMerge('status', localOp, remoteOp, baseState, stateMachine)

		expect(result.value).toBe('confirmed')
		expect(result.trace.strategy).toBe('state-machine-lww')
		expect(result.trace.constraintViolated).toBeNull()
	})

	test('concurrent valid transitions: LWW resolves (remote wins)', () => {
		const localOp = makeOp({ status: 'confirmed' }, 'node-a', 1000)
		const remoteOp = makeOp({ status: 'cancelled' }, 'node-b', 2000)
		const baseState = { status: 'pending' }

		const result = resolveStateMachineMerge('status', localOp, remoteOp, baseState, stateMachine)

		expect(result.value).toBe('cancelled')
		expect(result.trace.strategy).toBe('state-machine-lww')
	})

	test('one valid, one invalid: valid wins (local valid)', () => {
		const localOp = makeOp({ status: 'pending' }, 'node-a', 1000)
		const remoteOp = makeOp({ status: 'shipped' }, 'node-b', 2000) // invalid from draft
		const baseState = { status: 'draft' }

		const result = resolveStateMachineMerge('status', localOp, remoteOp, baseState, stateMachine)

		// Local is valid (draft -> pending), remote is invalid (draft -> shipped)
		// Valid wins regardless of timestamp
		expect(result.value).toBe('pending')
		expect(result.trace.strategy).toBe('state-machine-valid-wins')
		expect(result.trace.constraintViolated).toContain('invalid')
	})

	test('one valid, one invalid: valid wins (remote valid)', () => {
		const localOp = makeOp({ status: 'shipped' }, 'node-a', 2000) // invalid from draft
		const remoteOp = makeOp({ status: 'pending' }, 'node-b', 1000) // valid from draft
		const baseState = { status: 'draft' }

		const result = resolveStateMachineMerge('status', localOp, remoteOp, baseState, stateMachine)

		expect(result.value).toBe('pending')
		expect(result.trace.strategy).toBe('state-machine-valid-wins')
	})

	test('both invalid: base state preserved', () => {
		const localOp = makeOp({ status: 'shipped' }, 'node-a', 2000) // invalid from draft
		const remoteOp = makeOp({ status: 'delivered' }, 'node-b', 1000) // invalid from draft
		const baseState = { status: 'draft' }

		const result = resolveStateMachineMerge('status', localOp, remoteOp, baseState, stateMachine)

		expect(result.value).toBe('draft')
		expect(result.trace.strategy).toBe('state-machine-both-invalid')
		expect(result.trace.constraintViolated).toContain('Both transitions invalid')
	})

	test('only local changed and valid', () => {
		const localOp = makeOp({ status: 'pending' }, 'node-a', 1000)
		const remoteOp = makeOp({ total: 200 }, 'node-b', 2000) // does not touch status
		const baseState = { status: 'draft' }

		const result = resolveStateMachineMerge('status', localOp, remoteOp, baseState, stateMachine)

		expect(result.value).toBe('pending')
		expect(result.trace.strategy).toBe('state-machine-no-conflict-local')
	})

	test('only remote changed and valid', () => {
		const localOp = makeOp({ total: 100 }, 'node-a', 1000) // does not touch status
		const remoteOp = makeOp({ status: 'pending' }, 'node-b', 2000)
		const baseState = { status: 'draft' }

		const result = resolveStateMachineMerge('status', localOp, remoteOp, baseState, stateMachine)

		expect(result.value).toBe('pending')
		expect(result.trace.strategy).toBe('state-machine-no-conflict-remote')
	})

	test('only local changed and invalid: falls back to base', () => {
		const localOp = makeOp({ status: 'shipped' }, 'node-a', 1000)
		const remoteOp = makeOp({ total: 200 }, 'node-b', 2000)
		const baseState = { status: 'draft' }

		const result = resolveStateMachineMerge('status', localOp, remoteOp, baseState, stateMachine)

		expect(result.value).toBe('draft')
		expect(result.trace.strategy).toBe('state-machine-invalid-local')
		expect(result.trace.constraintViolated).toContain('Invalid transition')
	})

	test('neither side changed: base value preserved', () => {
		const localOp = makeOp({ total: 100 }, 'node-a', 1000)
		const remoteOp = makeOp({ total: 200 }, 'node-b', 2000)
		const baseState = { status: 'draft' }

		const result = resolveStateMachineMerge('status', localOp, remoteOp, baseState, stateMachine)

		expect(result.value).toBe('draft')
		expect(result.trace.strategy).toBe('state-machine-no-conflict-unchanged')
	})

	test('terminal state: both trying to leave produces both-invalid', () => {
		const localOp = makeOp({ status: 'draft' }, 'node-a', 1000)
		const remoteOp = makeOp({ status: 'pending' }, 'node-b', 2000)
		const baseState = { status: 'delivered' }

		const result = resolveStateMachineMerge('status', localOp, remoteOp, baseState, stateMachine)

		expect(result.value).toBe('delivered')
		expect(result.trace.strategy).toBe('state-machine-both-invalid')
	})

	test('trace records tier 2', () => {
		const localOp = makeOp({ status: 'pending' }, 'node-a', 2000)
		const remoteOp = makeOp({ status: 'cancelled' }, 'node-b', 1000)
		const baseState = { status: 'draft' }

		const result = resolveStateMachineMerge('status', localOp, remoteOp, baseState, stateMachine)

		expect(result.trace.tier).toBe(2)
		expect(result.trace.field).toBe('status')
		expect(result.trace.base).toBe('draft')
	})
})

describe('isStateMachineField', () => {
	test('returns true for the state machine field', () => {
		const collectionDef: CollectionDefinition = {
			fields: {},
			indexes: [],
			constraints: [],
			resolvers: {},
			scope: [],
			stateMachine,
		}

		expect(isStateMachineField(collectionDef, 'status')).toBe(true)
	})

	test('returns false for a non-state-machine field', () => {
		const collectionDef: CollectionDefinition = {
			fields: {},
			indexes: [],
			constraints: [],
			resolvers: {},
			scope: [],
			stateMachine,
		}

		expect(isStateMachineField(collectionDef, 'total')).toBe(false)
	})

	test('returns false when no state machine is defined', () => {
		const collectionDef: CollectionDefinition = {
			fields: {},
			indexes: [],
			constraints: [],
			resolvers: {},
			scope: [],
		}

		expect(isStateMachineField(collectionDef, 'status')).toBe(false)
	})
})
