import { defineSchema, op, t } from '@korajs/core'
import { beforeEach, describe, expect, test } from 'vitest'
import { MemoryServerStore } from '../store/memory-server-store'
import { KoraSyncServer } from './kora-sync-server'
import { type ProductionHttpRouteContext, createRouteContext } from './route-context'

const schema = defineSchema({
	version: 1,
	collections: {
		forms: {
			fields: {
				status: t.string(),
				responseCount: t.number(),
				maxResponses: t.number(),
			},
		},
		responses: {
			fields: {
				formId: t.string(),
				answer: t.string(),
			},
		},
	},
})

async function setup(): Promise<{ ctx: ProductionHttpRouteContext; store: MemoryServerStore }> {
	const store = new MemoryServerStore('server-1')
	await store.setSchema(schema)
	const server = new KoraSyncServer({ store })
	const ctx = createRouteContext(server, store)
	// Seed a published form with a hard cap of 2 and a zero counter.
	const seeded = await ctx.apply({
		collection: 'forms',
		type: 'insert',
		recordId: 'form-1',
		data: { status: 'published', responseCount: 0, maxResponses: 2 },
	})
	expect(seeded.ok).toBe(true)
	return { ctx, store }
}

function admitResponse(
	ctx: ProductionHttpRouteContext,
	responseId: string,
): Promise<import('./route-context').RouteConditionalResult> {
	return ctx.applyConditional({
		collection: 'forms',
		id: 'form-1',
		if: { status: { $eq: 'published' }, responseCount: { $lt: 2 } },
		update: { responseCount: op.increment(1) },
		also: [
			{
				collection: 'responses',
				type: 'insert',
				recordId: responseId,
				data: { formId: 'form-1', answer: 'a' },
			},
		],
		reject: { code: 'max_responses_reached', message: 'This form has reached its limit.' },
		idempotencyKey: { collection: 'responses', id: responseId },
	})
}

describe('applyConditional', () => {
	let ctx: ProductionHttpRouteContext
	let store: MemoryServerStore

	beforeEach(async () => {
		const s = await setup()
		ctx = s.ctx
		store = s.store
	})

	test('accepts while below the cap and increments the counter once per response', async () => {
		const first = await admitResponse(ctx, 'resp-1')
		expect(first.ok).toBe(true)

		const second = await admitResponse(ctx, 'resp-2')
		expect(second.ok).toBe(true)

		const form = await store.findRecord('forms', 'form-1')
		expect(form?.responseCount).toBe(2)
		expect(await store.findRecord('responses', 'resp-1')).not.toBeNull()
		expect(await store.findRecord('responses', 'resp-2')).not.toBeNull()
	})

	test('rejects at the cap without applying any mutation', async () => {
		await admitResponse(ctx, 'resp-1')
		await admitResponse(ctx, 'resp-2')

		const rejected = await admitResponse(ctx, 'resp-3')
		expect(rejected.ok).toBe(false)
		if (!rejected.ok) {
			expect(rejected.code).toBe('max_responses_reached')
			expect(rejected.retriable).toBe(false)
		}

		const form = await store.findRecord('forms', 'form-1')
		expect(form?.responseCount).toBe(2) // unchanged
		expect(await store.findRecord('responses', 'resp-3')).toBeNull() // not inserted
	})

	test('is idempotent: a retry with the same key does not increment again', async () => {
		const first = await admitResponse(ctx, 'resp-1')
		expect(first.ok).toBe(true)

		const retry = await admitResponse(ctx, 'resp-1')
		expect(retry.ok).toBe(true)
		if (retry.ok) {
			expect(retry.idempotent).toBe(true)
		}

		const form = await store.findRecord('forms', 'form-1')
		expect(form?.responseCount).toBe(1) // incremented once, not twice
	})

	test('applies nothing when any mutation in the set fails validation', async () => {
		// The predicate passes and the target update is buildable, but the `also`
		// mutation is malformed (update without a recordId). The whole set must be
		// rejected without committing the counter increment.
		const result = await ctx.applyConditional({
			collection: 'forms',
			id: 'form-1',
			if: { responseCount: { $lt: 2 } },
			update: { responseCount: op.increment(1) },
			also: [{ collection: 'responses', type: 'update', data: { answer: 'x' } }],
		})
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.code).toBe('MISSING_RECORD_ID')
		}

		const form = await store.findRecord('forms', 'form-1')
		expect(form?.responseCount).toBe(0) // increment was NOT applied
	})

	test('applies the multi-collection set with no predicate (uncapped form)', async () => {
		const result = await ctx.applyConditional({
			collection: 'forms',
			id: 'form-1',
			update: { responseCount: op.increment(1) },
			also: [
				{
					collection: 'responses',
					type: 'insert',
					recordId: 'resp-x',
					data: { formId: 'form-1', answer: 'b' },
				},
			],
			idempotencyKey: { collection: 'responses', id: 'resp-x' },
		})
		expect(result.ok).toBe(true)

		const form = await store.findRecord('forms', 'form-1')
		expect(form?.responseCount).toBe(1)
		expect(await store.findRecord('responses', 'resp-x')).not.toBeNull()
	})
})
