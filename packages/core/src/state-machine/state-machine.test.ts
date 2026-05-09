import { describe, expect, test } from 'vitest'
import { SchemaValidationError } from '../errors/errors'
import { defineSchema } from '../schema/define'
import { t } from '../schema/types'
import type { StateMachineConstraint } from '../types'
import { buildStateMachineConstraints, getTransitionMap, validateTransition } from './state-machine'

describe('validateTransition', () => {
	const orderConstraint: StateMachineConstraint = {
		field: 'status',
		collection: 'orders',
		transitions: {
			draft: ['submitted', 'cancelled'],
			submitted: ['approved', 'cancelled'],
			approved: ['shipped', 'cancelled'],
			shipped: ['delivered'],
			delivered: [],
			cancelled: [],
		},
	}

	test('valid transition: draft -> submitted passes', () => {
		const result = validateTransition(orderConstraint, 'draft', 'submitted')
		expect(result.valid).toBe(true)
		expect(result.from).toBe('draft')
		expect(result.to).toBe('submitted')
		expect(result.field).toBe('status')
		expect(result.collection).toBe('orders')
		expect(result.allowedTargets).toEqual(['submitted', 'cancelled'])
	})

	test('valid transition: draft -> cancelled passes', () => {
		const result = validateTransition(orderConstraint, 'draft', 'cancelled')
		expect(result.valid).toBe(true)
	})

	test('valid transition: submitted -> approved passes', () => {
		const result = validateTransition(orderConstraint, 'submitted', 'approved')
		expect(result.valid).toBe(true)
	})

	test('valid transition: shipped -> delivered passes', () => {
		const result = validateTransition(orderConstraint, 'shipped', 'delivered')
		expect(result.valid).toBe(true)
	})

	test('invalid transition: draft -> shipped fails', () => {
		const result = validateTransition(orderConstraint, 'draft', 'shipped')
		expect(result.valid).toBe(false)
		expect(result.from).toBe('draft')
		expect(result.to).toBe('shipped')
		expect(result.allowedTargets).toEqual(['submitted', 'cancelled'])
	})

	test('invalid transition: draft -> approved fails', () => {
		const result = validateTransition(orderConstraint, 'draft', 'approved')
		expect(result.valid).toBe(false)
	})

	test('invalid transition: draft -> delivered fails', () => {
		const result = validateTransition(orderConstraint, 'draft', 'delivered')
		expect(result.valid).toBe(false)
	})

	test('terminal state: delivered -> anything fails', () => {
		const targets = ['draft', 'submitted', 'approved', 'shipped', 'cancelled', 'delivered']
		for (const target of targets) {
			const result = validateTransition(orderConstraint, 'delivered', target)
			expect(result.valid).toBe(false)
			expect(result.allowedTargets).toEqual([])
		}
	})

	test('terminal state: cancelled -> anything fails', () => {
		const targets = ['draft', 'submitted', 'approved', 'shipped', 'delivered', 'cancelled']
		for (const target of targets) {
			const result = validateTransition(orderConstraint, 'cancelled', target)
			expect(result.valid).toBe(false)
			expect(result.allowedTargets).toEqual([])
		}
	})

	test('unknown source state returns empty allowed targets and fails', () => {
		// If a state is not present in the transition map, it has no allowed transitions
		const result = validateTransition(orderConstraint, 'nonexistent', 'draft')
		expect(result.valid).toBe(false)
		expect(result.from).toBe('nonexistent')
		expect(result.to).toBe('draft')
		expect(result.allowedTargets).toEqual([])
	})

	test('result includes correct field and collection', () => {
		const constraint: StateMachineConstraint = {
			field: 'phase',
			collection: 'projects',
			transitions: {
				planning: ['active'],
				active: ['complete'],
				complete: [],
			},
		}
		const result = validateTransition(constraint, 'planning', 'active')
		expect(result.field).toBe('phase')
		expect(result.collection).toBe('projects')
	})

	test('coerces non-string values to strings for comparison', () => {
		const constraint: StateMachineConstraint = {
			field: 'status',
			collection: 'items',
			transitions: {
				'1': ['2'],
				'2': ['3'],
				'3': [],
			},
		}
		const result = validateTransition(constraint, 1, 2)
		expect(result.valid).toBe(true)
		expect(result.from).toBe('1')
		expect(result.to).toBe('2')
	})

	test('all declared transitions are enumerated in allowedTargets', () => {
		const result = validateTransition(orderConstraint, 'submitted', 'approved')
		expect(result.allowedTargets).toEqual(['approved', 'cancelled'])
	})

	test('self-transition is invalid when not declared', () => {
		const result = validateTransition(orderConstraint, 'draft', 'draft')
		expect(result.valid).toBe(false)
	})

	test('self-transition is valid when declared', () => {
		const constraint: StateMachineConstraint = {
			field: 'status',
			collection: 'tasks',
			transitions: {
				active: ['active', 'done'],
				done: [],
			},
		}
		const result = validateTransition(constraint, 'active', 'active')
		expect(result.valid).toBe(true)
	})
})

describe('buildStateMachineConstraints', () => {
	test('extracts constraint from enum field with transitions', () => {
		const schema = defineSchema({
			version: 1,
			collections: {
				orders: {
					fields: {
						status: t
							.enum(['draft', 'submitted', 'approved'])
							.default('draft')
							.transitions({
								draft: ['submitted'],
								submitted: ['approved'],
								approved: [],
							}),
						title: t.string(),
					},
				},
			},
		})

		const constraints = buildStateMachineConstraints(schema)
		expect(constraints).toHaveLength(1)
		expect(constraints[0]?.field).toBe('status')
		expect(constraints[0]?.collection).toBe('orders')
		expect(constraints[0]?.transitions).toEqual({
			draft: ['submitted'],
			submitted: ['approved'],
			approved: [],
		})
	})

	test('returns empty array when no fields have transitions', () => {
		const schema = defineSchema({
			version: 1,
			collections: {
				items: {
					fields: {
						name: t.string(),
						status: t.enum(['a', 'b']).default('a'),
					},
				},
			},
		})

		const constraints = buildStateMachineConstraints(schema)
		expect(constraints).toEqual([])
	})

	test('extracts multiple constraints from same collection', () => {
		const schema = defineSchema({
			version: 1,
			collections: {
				tickets: {
					fields: {
						status: t
							.enum(['open', 'in_progress', 'closed'])
							.default('open')
							.transitions({
								open: ['in_progress'],
								in_progress: ['closed'],
								closed: [],
							}),
						priority: t
							.enum(['low', 'high', 'critical'])
							.default('low')
							.transitions({
								low: ['high', 'critical'],
								high: ['critical'],
								critical: [],
							}),
						title: t.string(),
					},
				},
			},
		})

		const constraints = buildStateMachineConstraints(schema)
		expect(constraints).toHaveLength(2)

		const statusConstraint = constraints.find((c) => c.field === 'status')
		const priorityConstraint = constraints.find((c) => c.field === 'priority')

		expect(statusConstraint).toBeDefined()
		expect(priorityConstraint).toBeDefined()
		expect(statusConstraint?.transitions.open).toEqual(['in_progress'])
		expect(priorityConstraint?.transitions.low).toEqual(['high', 'critical'])
	})

	test('extracts constraints from multiple collections', () => {
		const schema = defineSchema({
			version: 1,
			collections: {
				orders: {
					fields: {
						status: t
							.enum(['draft', 'paid'])
							.default('draft')
							.transitions({
								draft: ['paid'],
								paid: [],
							}),
					},
				},
				tasks: {
					fields: {
						phase: t
							.enum(['todo', 'done'])
							.default('todo')
							.transitions({
								todo: ['done'],
								done: [],
							}),
					},
				},
			},
		})

		const constraints = buildStateMachineConstraints(schema)
		expect(constraints).toHaveLength(2)

		const orderConstraint = constraints.find((c) => c.collection === 'orders')
		const taskConstraint = constraints.find((c) => c.collection === 'tasks')

		expect(orderConstraint?.field).toBe('status')
		expect(taskConstraint?.field).toBe('phase')
	})

	test('ignores enum fields without transitions', () => {
		const schema = defineSchema({
			version: 1,
			collections: {
				items: {
					fields: {
						status: t
							.enum(['a', 'b'])
							.default('a')
							.transitions({
								a: ['b'],
								b: [],
							}),
						category: t.enum(['x', 'y', 'z']).default('x'), // no transitions
					},
				},
			},
		})

		const constraints = buildStateMachineConstraints(schema)
		expect(constraints).toHaveLength(1)
		expect(constraints[0]?.field).toBe('status')
	})

	test('ignores non-enum fields', () => {
		const schema = defineSchema({
			version: 1,
			collections: {
				items: {
					fields: {
						name: t.string(),
						count: t.number(),
						active: t.boolean().default(true),
						tags: t.array(t.string()).default([]),
					},
				},
			},
		})

		const constraints = buildStateMachineConstraints(schema)
		expect(constraints).toEqual([])
	})
})

describe('getTransitionMap', () => {
	const schema = defineSchema({
		version: 1,
		collections: {
			orders: {
				fields: {
					status: t
						.enum(['draft', 'submitted'])
						.default('draft')
						.transitions({
							draft: ['submitted'],
							submitted: [],
						}),
					category: t.enum(['a', 'b']).default('a'),
					title: t.string(),
				},
			},
			items: {
				fields: {
					name: t.string(),
				},
			},
		},
	})

	test('returns transition map for field with transitions', () => {
		const map = getTransitionMap(schema, 'orders', 'status')
		expect(map).toEqual({
			draft: ['submitted'],
			submitted: [],
		})
	})

	test('returns null for enum field without transitions', () => {
		const map = getTransitionMap(schema, 'orders', 'category')
		expect(map).toBeNull()
	})

	test('returns null for non-enum field', () => {
		const map = getTransitionMap(schema, 'orders', 'title')
		expect(map).toBeNull()
	})

	test('returns null for non-existent field', () => {
		const map = getTransitionMap(schema, 'orders', 'nonexistent')
		expect(map).toBeNull()
	})

	test('returns null for non-existent collection', () => {
		const map = getTransitionMap(schema, 'nonexistent', 'status')
		expect(map).toBeNull()
	})
})

describe('EnumFieldBuilder.transitions()', () => {
	test('stores transition map in field descriptor', () => {
		const desc = t
			.enum(['draft', 'published', 'archived'])
			.transitions({
				draft: ['published'],
				published: ['archived'],
				archived: [],
			})
			._build()

		expect(desc.transitions).toEqual({
			draft: ['published'],
			published: ['archived'],
			archived: [],
		})
	})

	test('transitions field is null when not declared', () => {
		const desc = t.enum(['a', 'b', 'c'])._build()
		expect(desc.transitions).toBeNull()
	})

	test('chains with .default()', () => {
		const desc = t
			.enum(['draft', 'published'])
			.default('draft')
			.transitions({
				draft: ['published'],
				published: [],
			})
			._build()

		expect(desc.defaultValue).toBe('draft')
		expect(desc.required).toBe(false)
		expect(desc.transitions).toEqual({
			draft: ['published'],
			published: [],
		})
	})

	test('chains with .optional()', () => {
		const desc = t
			.enum(['draft', 'published'])
			.optional()
			.transitions({
				draft: ['published'],
				published: [],
			})
			._build()

		expect(desc.required).toBe(false)
		expect(desc.transitions).toEqual({
			draft: ['published'],
			published: [],
		})
	})

	test('chains with .merge()', () => {
		const desc = t
			.enum(['draft', 'published'])
			.merge('lww')
			.transitions({
				draft: ['published'],
				published: [],
			})
			._build()

		expect(desc.mergeStrategy).toBe('lww')
		expect(desc.transitions).toEqual({
			draft: ['published'],
			published: [],
		})
	})

	test('.default() after .transitions() preserves transitions', () => {
		const desc = t
			.enum(['draft', 'published'])
			.transitions({
				draft: ['published'],
				published: [],
			})
			.default('draft')
			._build()

		expect(desc.defaultValue).toBe('draft')
		expect(desc.transitions).toEqual({
			draft: ['published'],
			published: [],
		})
	})

	test('.optional() after .transitions() preserves transitions', () => {
		const desc = t
			.enum(['draft', 'published'])
			.transitions({
				draft: ['published'],
				published: [],
			})
			.optional()
			._build()

		expect(desc.required).toBe(false)
		expect(desc.transitions).toEqual({
			draft: ['published'],
			published: [],
		})
	})

	test('.merge() after .transitions() preserves transitions', () => {
		const desc = t
			.enum(['draft', 'published'])
			.transitions({
				draft: ['published'],
				published: [],
			})
			.merge('server-authoritative')
			._build()

		expect(desc.mergeStrategy).toBe('server-authoritative')
		expect(desc.transitions).toEqual({
			draft: ['published'],
			published: [],
		})
	})

	test('throws on invalid source state in transition map', () => {
		expect(() =>
			t.enum(['draft', 'published']).transitions({
				draft: ['published'],
				published: [],
				// @ts-expect-error: deliberately testing invalid state
				invalid_state: ['draft'],
			}),
		).toThrow(SchemaValidationError)
	})

	test('throws on invalid target state in transition map', () => {
		expect(() =>
			t.enum(['draft', 'published']).transitions({
				// @ts-expect-error: deliberately testing invalid target
				draft: ['published', 'nonexistent'],
				published: [],
			}),
		).toThrow(SchemaValidationError)
	})

	test('error message includes the invalid state name', () => {
		try {
			t.enum(['draft', 'published']).transitions({
				draft: ['published'],
				published: [],
				// @ts-expect-error: deliberately testing invalid state
				bogus: ['draft'],
			})
			expect.fail('Should have thrown')
		} catch (e) {
			expect(e).toBeInstanceOf(SchemaValidationError)
			expect((e as SchemaValidationError).message).toContain('bogus')
			expect((e as SchemaValidationError).message).toContain('draft')
			expect((e as SchemaValidationError).message).toContain('published')
		}
	})

	test('error message includes the invalid target state name', () => {
		try {
			t.enum(['draft', 'published']).transitions({
				// @ts-expect-error: deliberately testing invalid target
				draft: ['nowhere'],
				published: [],
			})
			expect.fail('Should have thrown')
		} catch (e) {
			expect(e).toBeInstanceOf(SchemaValidationError)
			expect((e as SchemaValidationError).message).toContain('nowhere')
			expect((e as SchemaValidationError).message).toContain('from "draft"')
		}
	})

	test('supports partial transition maps (not all states need entries)', () => {
		// Only specifying transitions for some states is valid.
		// States without entries have no allowed transitions (treated as terminal).
		const desc = t
			.enum(['draft', 'submitted', 'approved'])
			.transitions({
				draft: ['submitted'],
				// submitted and approved not declared — they are implicitly terminal
			})
			._build()

		expect(desc.transitions).toEqual({
			draft: ['submitted'],
		})
	})

	test('builder immutability: .transitions() does not mutate original', () => {
		const base = t.enum(['draft', 'published'])
		const withTransitions = base.transitions({
			draft: ['published'],
			published: [],
		})

		expect(base._build().transitions).toBeNull()
		expect(withTransitions._build().transitions).toEqual({
			draft: ['published'],
			published: [],
		})
	})

	test('preserves enum values through transition chaining', () => {
		const desc = t
			.enum(['draft', 'published', 'archived'])
			.transitions({
				draft: ['published'],
				published: ['archived'],
				archived: [],
			})
			._build()

		expect(desc.enumValues).toEqual(['draft', 'published', 'archived'])
	})

	test('allows empty transition map', () => {
		// All states are terminal
		const desc = t.enum(['a', 'b']).transitions({})._build()
		expect(desc.transitions).toEqual({})
	})
})

describe('end-to-end: schema + validate', () => {
	test('defineSchema + buildStateMachineConstraints + validateTransition', () => {
		const schema = defineSchema({
			version: 1,
			collections: {
				orders: {
					fields: {
						status: t
							.enum(['draft', 'submitted', 'approved', 'shipped', 'delivered', 'cancelled'])
							.default('draft')
							.transitions({
								draft: ['submitted', 'cancelled'],
								submitted: ['approved', 'cancelled'],
								approved: ['shipped', 'cancelled'],
								shipped: ['delivered'],
								delivered: [],
								cancelled: [],
							}),
						title: t.string(),
					},
				},
			},
		})

		const constraints = buildStateMachineConstraints(schema)
		expect(constraints).toHaveLength(1)
		const constraint = constraints[0]
		if (!constraint) {
			expect.fail('Expected constraint')
			return
		}

		// Valid transitions
		expect(validateTransition(constraint, 'draft', 'submitted').valid).toBe(true)
		expect(validateTransition(constraint, 'draft', 'cancelled').valid).toBe(true)
		expect(validateTransition(constraint, 'submitted', 'approved').valid).toBe(true)
		expect(validateTransition(constraint, 'approved', 'shipped').valid).toBe(true)
		expect(validateTransition(constraint, 'shipped', 'delivered').valid).toBe(true)

		// Invalid transitions
		expect(validateTransition(constraint, 'draft', 'approved').valid).toBe(false)
		expect(validateTransition(constraint, 'draft', 'shipped').valid).toBe(false)
		expect(validateTransition(constraint, 'draft', 'delivered').valid).toBe(false)
		expect(validateTransition(constraint, 'shipped', 'cancelled').valid).toBe(false)
		expect(validateTransition(constraint, 'delivered', 'draft').valid).toBe(false)
		expect(validateTransition(constraint, 'cancelled', 'draft').valid).toBe(false)
	})
})
