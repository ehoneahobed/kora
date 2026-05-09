import type { CollectionDefinition, StateMachineDefinition } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import {
	InvalidStateTransitionError,
	validateStateTransition,
	validateUpdateStateMachine,
} from './state-validator'

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

const lastValidStateMachine: StateMachineDefinition = {
	...stateMachine,
	onInvalidTransition: 'last-valid-state',
}

function makeCollectionDef(sm?: StateMachineDefinition): CollectionDefinition {
	return {
		fields: {
			status: {
				kind: 'enum',
				required: true,
				defaultValue: 'draft',
				auto: false,
				enumValues: ['draft', 'pending', 'confirmed', 'shipped', 'delivered', 'cancelled'],
				itemKind: null,
				mergeStrategy: null,
			},
			total: {
				kind: 'number',
				required: true,
				defaultValue: undefined,
				auto: false,
				enumValues: null,
				itemKind: null,
				mergeStrategy: null,
			},
		},
		indexes: [],
		constraints: [],
		resolvers: {},
		scope: [],
		stateMachine: sm,
	}
}

describe('validateStateTransition', () => {
	test('valid transition accepted', () => {
		const result = validateStateTransition('orders', 'rec-1', stateMachine, 'draft', 'pending')
		expect(result.valid).toBe(true)
	})

	test('invalid transition in reject mode throws InvalidStateTransitionError', () => {
		expect(() =>
			validateStateTransition('orders', 'rec-1', stateMachine, 'draft', 'shipped'),
		).toThrow(InvalidStateTransitionError)
	})

	test('invalid transition error has correct code', () => {
		try {
			validateStateTransition('orders', 'rec-1', stateMachine, 'draft', 'shipped')
			expect.unreachable()
		} catch (err) {
			expect(err).toBeInstanceOf(InvalidStateTransitionError)
			const error = err as InvalidStateTransitionError
			expect(error.code).toBe('INVALID_STATE_TRANSITION')
			expect(error.collection).toBe('orders')
			expect(error.recordId).toBe('rec-1')
			expect(error.field).toBe('status')
			expect(error.fromState).toBe('draft')
			expect(error.toState).toBe('shipped')
			expect(error.allowedStates).toEqual(['pending', 'cancelled'])
		}
	})

	test('terminal state: no transitions allowed (reject mode)', () => {
		expect(() =>
			validateStateTransition('orders', 'rec-1', stateMachine, 'delivered', 'draft'),
		).toThrow(InvalidStateTransitionError)
	})

	test('terminal state error message mentions terminal', () => {
		try {
			validateStateTransition('orders', 'rec-1', stateMachine, 'delivered', 'draft')
			expect.unreachable()
		} catch (err) {
			const error = err as InvalidStateTransitionError
			expect(error.message).toContain('none')
			expect(error.allowedStates).toEqual([])
		}
	})

	test('same-state transition is always valid', () => {
		const result = validateStateTransition(
			'orders',
			'rec-1',
			stateMachine,
			'delivered',
			'delivered',
		)
		expect(result.valid).toBe(true)
	})

	test('insert (null current state) is always valid', () => {
		const result = validateStateTransition('orders', 'rec-1', stateMachine, null, 'draft')
		expect(result.valid).toBe(true)
	})

	test('last-valid-state mode: invalid transition returns invalid without throwing', () => {
		const result = validateStateTransition(
			'orders',
			'rec-1',
			lastValidStateMachine,
			'draft',
			'shipped',
		)
		expect(result.valid).toBe(false)
		expect(result.allowedStates).toEqual(['pending', 'cancelled'])
	})

	test('last-valid-state mode: valid transition returns valid', () => {
		const result = validateStateTransition(
			'orders',
			'rec-1',
			lastValidStateMachine,
			'draft',
			'pending',
		)
		expect(result.valid).toBe(true)
	})
})

describe('validateUpdateStateMachine', () => {
	test('passes through when no state machine is defined', () => {
		const collectionDef = makeCollectionDef(undefined)
		const result = validateUpdateStateMachine(
			'orders',
			'rec-1',
			collectionDef,
			{ status: 'draft', total: 100 },
			{ status: 'shipped' },
		)
		expect(result).toEqual({ status: 'shipped' })
	})

	test('passes through when state field is not in update data', () => {
		const collectionDef = makeCollectionDef(stateMachine)
		const result = validateUpdateStateMachine(
			'orders',
			'rec-1',
			collectionDef,
			{ status: 'draft', total: 100 },
			{ total: 200 },
		)
		expect(result).toEqual({ total: 200 })
	})

	test('accepts valid state transition', () => {
		const collectionDef = makeCollectionDef(stateMachine)
		const result = validateUpdateStateMachine(
			'orders',
			'rec-1',
			collectionDef,
			{ status: 'draft', total: 100 },
			{ status: 'pending' },
		)
		expect(result).toEqual({ status: 'pending' })
	})

	test('reject mode: throws on invalid state transition', () => {
		const collectionDef = makeCollectionDef(stateMachine)
		expect(() =>
			validateUpdateStateMachine(
				'orders',
				'rec-1',
				collectionDef,
				{ status: 'draft', total: 100 },
				{ status: 'shipped' },
			),
		).toThrow(InvalidStateTransitionError)
	})

	test('last-valid-state mode: removes state field from update on invalid transition', () => {
		const collectionDef = makeCollectionDef(lastValidStateMachine)
		const result = validateUpdateStateMachine(
			'orders',
			'rec-1',
			collectionDef,
			{ status: 'draft', total: 100 },
			{ status: 'shipped', total: 200 },
		)
		// State field should be removed, total remains
		expect(result).toEqual({ total: 200 })
		expect('status' in result).toBe(false)
	})

	test('last-valid-state mode: returns empty object when only state field was in update', () => {
		const collectionDef = makeCollectionDef(lastValidStateMachine)
		const result = validateUpdateStateMachine(
			'orders',
			'rec-1',
			collectionDef,
			{ status: 'draft', total: 100 },
			{ status: 'shipped' },
		)
		expect(result).toEqual({})
	})
})
