import { describe, expect, test } from 'vitest'
import { defineSchema } from '../schema/define'
import { t } from '../schema/types'
import type { CollectionDefinition } from '../types'
import { decryptSecret, verifySecret } from './secret-crypto'
import {
	MissingSecretKeyError,
	revealSecret,
	transformSecretFieldsForWrite,
	verifySecretValue,
} from './secret-transform'

const schema = defineSchema({
	version: 1,
	collections: {
		users: {
			fields: {
				email: t.string(),
				password: t.secret().hashed(),
				apiKey: t.secret().encrypted(),
			},
		},
	},
})
const users = schema.collections.users as CollectionDefinition

const KEY = 'encryption-key-material'
const keyProvider = () => KEY

describe('transformSecretFieldsForWrite', () => {
	test('hashes a hashed secret field (one-way, plaintext absent)', async () => {
		const out = await transformSecretFieldsForWrite(
			{ email: 'a@b.com', password: 'hunter2' },
			users,
			keyProvider,
		)
		expect(out.email).toBe('a@b.com') // non-secret untouched
		expect(out.password).not.toBe('hunter2')
		expect(String(out.password)).not.toContain('hunter2')
		expect(await verifySecret('hunter2', out.password as string)).toBe(true)
	})

	test('encrypts an encrypted secret field (reversible, plaintext absent)', async () => {
		const out = await transformSecretFieldsForWrite({ apiKey: 'sk_live_x' }, users, keyProvider)
		expect(out.apiKey).not.toBe('sk_live_x')
		expect(String(out.apiKey)).not.toContain('sk_live_x')
		expect(await decryptSecret(out.apiKey as string, KEY)).toBe('sk_live_x')
	})

	test('throws when an encrypted field has no key configured', async () => {
		await expect(
			transformSecretFieldsForWrite({ apiKey: 'x' }, users, undefined),
		).rejects.toBeInstanceOf(MissingSecretKeyError)
	})

	test('hashed fields need no key', async () => {
		const out = await transformSecretFieldsForWrite({ password: 'pw' }, users, undefined)
		expect(await verifySecret('pw', out.password as string)).toBe(true)
	})

	test('passes through when the field is absent (partial update)', async () => {
		const out = await transformSecretFieldsForWrite({ email: 'only' }, users, keyProvider)
		expect(out).toEqual({ email: 'only' })
	})

	test('leaves a collection with no secret fields untouched (same reference)', async () => {
		const plain = { title: 'x' } as Record<string, unknown>
		const def = schema.collections.users
		const noSecret: CollectionDefinition = {
			...(def as CollectionDefinition),
			fields: { title: (def as CollectionDefinition).fields.email as never },
		}
		// email is a string field here; no secret kind → fast path returns input.
		const out = await transformSecretFieldsForWrite(plain, noSecret, keyProvider)
		expect(out).toBe(plain)
	})
})

describe('revealSecret / verifySecretValue', () => {
	test('reveals an encrypted secret back to plaintext', async () => {
		const out = await transformSecretFieldsForWrite({ apiKey: 'token-123' }, users, keyProvider)
		expect(await revealSecret(out.apiKey as string, 'encrypted', keyProvider, 'apiKey')).toBe(
			'token-123',
		)
	})

	test('refuses to reveal a hashed secret', async () => {
		const out = await transformSecretFieldsForWrite({ password: 'pw' }, users, keyProvider)
		await expect(
			revealSecret(out.password as string, 'hashed', keyProvider, 'password'),
		).rejects.toThrow(/one-way/)
	})

	test('verifySecretValue checks a candidate against a hashed value', async () => {
		const out = await transformSecretFieldsForWrite({ password: 'correct' }, users, keyProvider)
		expect(await verifySecretValue('correct', out.password as string)).toBe(true)
		expect(await verifySecretValue('wrong', out.password as string)).toBe(false)
	})
})
