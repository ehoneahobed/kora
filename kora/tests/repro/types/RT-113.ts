// RT-113 tsc probe (Codex review of PR #4, core schema/infer.ts InferUpdateField). Correct
// typing => ZERO errors: every op.* helper returned the same broad AtomicOpSentinel, so an
// update accepted any helper on any number, timestamp or array field and an item of any
// type in op.append / op.remove. The runtime refuses those writes (the resolved value is
// out of the field's domain), so the typed API must reject them at compile time. Each
// "@ts-expect-error" below compiled before the fix (TS2578).
// Run: npx tsc --noEmit --strict --skipLibCheck --module esnext --moduleResolution bundler --target es2022 --jsx react-jsx tests/repro/types/RT-113.ts
import { createApp, defineSchema, op, t } from 'korajs'

const schema = defineSchema({
	version: 1,
	collections: {
		items: {
			fields: {
				title: t.string(),
				count: t.number().default(0),
				seenAt: t.timestamp().optional(),
				flag: t.boolean().default(false),
				tags: t.array(t.string()).default([]),
				levels: t.array(t.enum(['low', 'high'])).default([]),
				scores: t.array(t.number()).default([]),
				points: t.array(t.object({ x: t.number(), y: t.number() })).default([]),
			},
		},
	},
})

const app = createApp({ schema })

export async function accepted(id: string, tag: string): Promise<void> {
	// Numeric helpers on number and timestamp fields.
	await app.items.update(id, {
		count: op.increment(1),
		seenAt: op.max(Date.now()),
	})
	await app.items.update(id, { count: op.decrement(2) })
	await app.items.update(id, { count: op.min(0) })
	await app.items.update(id, { seenAt: op.increment(1000) })
	// Array helpers with the element type.
	await app.items.update(id, { tags: op.append('urgent') })
	await app.items.update(id, { tags: op.remove(tag) })
	await app.items.update(id, { levels: op.append('high') })
	await app.items.update(id, { scores: op.append(3) })
	await app.items.update(id, { points: op.append({ x: 1, y: 2 }) })
	await app.items.update(id, { points: op.remove({ x: 1, y: 2 }) })
	// A helper built ahead of the call keeps its type.
	const bump = op.increment(5)
	const urgent = op.append('urgent')
	await app.items.update(id, { count: bump, tags: urgent })
	// Plain values and null still work as before.
	await app.items.update(id, { count: 3, tags: ['a'], seenAt: null })
	await app.transaction(async (tx) => {
		await tx.items.update(id, { count: op.increment(1), tags: op.append('x') })
	})
}

export async function refused(id: string): Promise<void> {
	// @ts-expect-error op.append on a number field (runtime: the result is an array)
	await app.items.update(id, { count: op.append('x') })
	// @ts-expect-error op.remove on a timestamp field
	await app.items.update(id, { seenAt: op.remove(1) })
	// @ts-expect-error op.increment on an array field (runtime: the result is a number)
	await app.items.update(id, { tags: op.increment(1) })
	// @ts-expect-error op.max on an array field
	await app.items.update(id, { scores: op.max(1) })
	// @ts-expect-error an item of the wrong type in op.append on a string[] field
	await app.items.update(id, { tags: op.append(1) })
	// @ts-expect-error a value outside the enum in op.append on an enum array
	await app.items.update(id, { levels: op.append('urgent') })
	// @ts-expect-error op.remove with an item of the wrong type
	await app.items.update(id, { scores: op.remove('3') })
	// @ts-expect-error an object item missing a property
	await app.items.update(id, { points: op.append({ x: 1 }) })
	// @ts-expect-error no helper applies to a string field
	await app.items.update(id, { title: op.increment(1) })
	// @ts-expect-error no helper applies to a boolean field
	await app.items.update(id, { flag: op.append(true) })
	const bump = op.increment(5)
	// @ts-expect-error a numeric helper built ahead of the call, on an array field
	await app.items.update(id, { tags: bump })
	await app.transaction(async (tx) => {
		// @ts-expect-error the same rules inside a transaction
		await tx.items.update(id, { count: op.append('x') })
	})
}
