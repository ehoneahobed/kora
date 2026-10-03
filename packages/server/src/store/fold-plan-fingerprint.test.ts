import {
	foldPlanFingerprint as coreFoldPlanFingerprint,
	defineSchema,
	foldPlanFingerprints,
	t,
} from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { foldPlanFingerprint, serverFoldPlanFingerprint } from './record-fold'

const schemaV1 = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				done: t.boolean().default(false),
				tags: t.array(t.string()).default([]),
				stock: t.number().default(0),
			},
		},
		notes: { fields: { body: t.string(), owner: t.string().optional() } },
	},
})

const schemaV2 = defineSchema({
	version: 2,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				done: t.boolean().default(false),
				tags: t.array(t.string()).default([]),
				stock: t.number().default(0),
			},
			resolve: {
				stock: (local, remote, base) => Number(local) + Number(remote) - Number(base),
			},
		},
		notes: { fields: { body: t.string(), owner: t.string().optional() } },
	},
})

describe('fold plan fingerprint: one definition for client and server', () => {
	test('the server uses the core definition (same function, same value)', () => {
		expect(foldPlanFingerprint).toBe(coreFoldPlanFingerprint)
		for (const schema of [schemaV1, schemaV2]) {
			expect(foldPlanFingerprint(schema)).toBe(coreFoldPlanFingerprint(schema))
		}
	})

	test('the server fingerprint agrees with the per-collection fingerprints a client store persists', () => {
		for (const schema of [schemaV1, schemaV2]) {
			const perCollection = foldPlanFingerprints(schema)
			const [format, ...collections] = foldPlanFingerprint(schema).split('|')
			expect(Object.keys(perCollection).sort()).toEqual(Object.keys(schema.collections).sort())
			for (const name of Object.keys(perCollection)) {
				const part = collections.find((c) => c.startsWith(`${name}(`))
				expect(perCollection[name]).toBe(`${format}|${part}`)
			}
		}
	})

	test('a re-planned field changes both fingerprints; an unchanged collection keeps its own', () => {
		expect(foldPlanFingerprint(schemaV1)).not.toBe(foldPlanFingerprint(schemaV2))
		const a = foldPlanFingerprints(schemaV1)
		const b = foldPlanFingerprints(schemaV2)
		expect(a.todos).not.toBe(b.todos)
		expect(a.notes).toBe(b.notes)
	})

	test('the server fingerprint extends the shared plan with its explicit authorities', () => {
		const plain = serverFoldPlanFingerprint(schemaV1, [])
		expect(plain.startsWith(`${coreFoldPlanFingerprint(schemaV1)}|auth:`)).toBe(true)
		expect(serverFoldPlanFingerprint(schemaV1, ['server-1'])).not.toBe(plain)
	})
})
