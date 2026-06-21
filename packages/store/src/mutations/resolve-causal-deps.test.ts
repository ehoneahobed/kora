import { CausalTracker } from '@korajs/core'
import { defineSchema, t } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { resolveCausalDeps } from './resolve-causal-deps'
import type { LocalMutationContext } from './types'

const schema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
			},
		},
	},
})

function minimalCtx(overrides: Partial<LocalMutationContext>): LocalMutationContext {
	const definition = schema.collections.todos
	if (!definition) {
		throw new Error('missing todos definition')
	}
	return {
		collection: 'todos',
		definition,
		schema,
		adapter: {} as LocalMutationContext['adapter'],
		clock: {} as LocalMutationContext['clock'],
		nodeId: 'node-1',
		allocateSequenceNumber: async () => 1,
		onMutation: () => {},
		relationEnforcer: null,
		causalTracker: null,
		inTransaction: false,
		...overrides,
	}
}

describe('resolveCausalDeps', () => {
	test('merges extra parent deps with tracker deps without duplicates', () => {
		const tracker = new CausalTracker()
		tracker.afterOperation('todos', 'op-head', false)

		const deps = resolveCausalDeps(
			minimalCtx({
				causalTracker: tracker,
				extraCausalDeps: ['parent-delete'],
			}),
		)

		expect(deps).toEqual(['parent-delete', 'op-head'])
	})
})
