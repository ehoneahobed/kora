import { describe, expect, test, vi } from 'vitest'
import { defineSchema } from '../schema/define'
import { t } from '../schema/types'
import {
	type FormDraftStorage,
	clearFormDrafts,
	createFormDraft,
	formDraftAppInfo,
	formDraftPrefix,
} from './form-draft'

class MemoryStorage implements FormDraftStorage {
	readonly items = new Map<string, string>()
	getItem(key: string): string | null {
		return this.items.get(key) ?? null
	}
	setItem(key: string, value: string): void {
		this.items.set(key, value)
	}
	removeItem(key: string): void {
		this.items.delete(key)
	}
	get length(): number {
		return this.items.size
	}
	key(index: number): string | null {
		return [...this.items.keys()][index] ?? null
	}
}

const schema = defineSchema({
	version: 1,
	collections: {
		patients: {
			fields: { name: t.string(), apiKey: t.secret(), notes: t.string().optional() },
		},
	},
})

const app = { dbName: 'clinic', encrypted: false, schema }

describe('form drafts (version gate section 6.1)', () => {
	test('rule 1: opt-in and allow-listed; an unlisted field is never stored', () => {
		const storage = new MemoryStorage()
		const draft = createFormDraft('intake', { fields: ['name'] }, app, storage)
		draft.save({ name: 'Ada', notes: 'unlisted' } as Record<string, unknown>)
		const stored = JSON.parse(storage.getItem('kora-draft:clinic:intake') ?? '{}')
		expect(stored.values).toEqual({ name: 'Ada' })
		// Nothing is stored for a form that never created a draft.
		expect([...storage.items.keys()]).toEqual(['kora-draft:clinic:intake'])
	})

	test('rule 2: password inputs, data-kora-sensitive, t.secret() and app-marked fields are excluded', () => {
		const storage = new MemoryStorage()
		const draft = createFormDraft(
			'intake',
			{
				fields: ['name', 'apiKey', 'notes', 'pin', 'ssn'],
				collection: 'patients',
				sensitive: ['ssn'],
			},
			app,
			storage,
		)
		const inputs = (field: string) =>
			field === 'pin'
				? { type: 'password' }
				: field === 'notes'
					? { sensitive: true }
					: { type: 'text' }
		draft.save({ name: 'Ada', apiKey: 'k', notes: 'n', pin: '1234', ssn: '000' }, inputs)
		expect(JSON.parse(storage.getItem('kora-draft:clinic:intake') ?? '{}').values).toEqual({
			name: 'Ada',
		})
	})

	test('rule 2: a field that becomes a password input has its stored value removed on the next save', () => {
		const storage = new MemoryStorage()
		const draft = createFormDraft(
			'login',
			{ fields: ['secret', 'user'] },
			{ ...app, schema: null },
			storage,
		)
		draft.save({ secret: 'visible', user: 'u' }, () => ({ type: 'text' }))
		expect(storage.getItem('kora-draft:clinic:login')).toContain('visible')
		draft.save({ secret: 'visible', user: 'u' }, (field) => ({
			type: field === 'secret' ? 'password' : 'text',
		}))
		expect(storage.getItem('kora-draft:clinic:login')).not.toContain('visible')
	})

	test('rule 2: allowSensitive drafts a listed sensitive field', () => {
		const storage = new MemoryStorage()
		const draft = createFormDraft(
			'intake',
			{ fields: ['ssn'], sensitive: ['ssn'], allowSensitive: ['ssn'] },
			app,
			storage,
		)
		draft.save({ ssn: '000' })
		expect(storage.getItem('kora-draft:clinic:intake')).toContain('000')
	})

	test('rule 2: with a collection, nothing is drafted until the schema is known', () => {
		const storage = new MemoryStorage()
		let known: typeof schema | null = null
		const draft = createFormDraft(
			'intake',
			{ fields: ['name'], collection: 'patients' },
			() => ({
				...app,
				schema: known,
			}),
			storage,
		)
		draft.save({ name: 'Ada' })
		expect(storage.length).toBe(0)
		known = schema
		draft.save({ name: 'Ada' })
		expect(storage.length).toBe(1)
	})

	test('rule 2: a collection the schema does not have drafts nothing (fail closed)', () => {
		const storage = new MemoryStorage()
		const draft = createFormDraft(
			'intake',
			{ fields: ['name'], collection: 'patientz' },
			app,
			storage,
		)
		draft.save({ name: 'Ada' })
		expect(storage.length).toBe(0)
	})

	test('rule 3: with encryption enabled nothing is written to storage at all', () => {
		const storage = new MemoryStorage()
		const setItem = vi.spyOn(storage, 'setItem')
		const draft = createFormDraft(
			'intake',
			{ fields: ['name'] },
			{ ...app, encrypted: true },
			storage,
		)
		expect(draft.isEnabled()).toBe(false)
		draft.save({ name: 'Ada' })
		expect(setItem).not.toHaveBeenCalled()
		// A plaintext draft left by an earlier unencrypted session is removed, not restored.
		storage.items.set(
			'kora-draft:clinic:intake',
			JSON.stringify({ v: 1, user: null, values: { name: 'x' } }),
		)
		expect(draft.restore()).toBeNull()
		expect(storage.length).toBe(0)
	})

	test('rule 4: a restored draft is consumed; a second restore gets nothing', () => {
		const storage = new MemoryStorage()
		const draft = createFormDraft('intake', { fields: ['name'] }, app, storage)
		draft.save({ name: 'Ada' })
		expect(draft.restore()).toEqual({ name: 'Ada' })
		expect(storage.length).toBe(0)
		expect(draft.restore()).toBeNull()
	})

	test('rule 4: a draft of another user is not restored and is removed', () => {
		const storage = new MemoryStorage()
		createFormDraft('intake', { fields: ['name'], userId: 'alice' }, app, storage).save({
			name: 'A',
		})
		const bob = createFormDraft('intake', { fields: ['name'], userId: 'bob' }, app, storage)
		expect(bob.restore()).toBeNull()
		expect(storage.length).toBe(0)
	})

	test('rule 4: sign-out clears every draft of the database and nothing else', () => {
		const storage = new MemoryStorage()
		createFormDraft('a', { fields: ['name'] }, app, storage).save({ name: '1' })
		createFormDraft('b', { fields: ['name'] }, app, storage).save({ name: '2' })
		createFormDraft('a', { fields: ['name'] }, { ...app, dbName: 'other' }, storage).save({
			name: '3',
		})
		storage.setItem('unrelated', 'keep')
		expect(clearFormDrafts({ storeInfo: () => ({ baseName: 'clinic' }) }, storage)).toBe(2)
		expect([...storage.items.keys()].sort()).toEqual([`${formDraftPrefix('other')}a`, 'unrelated'])
	})

	test('clear() after a successful submit; storage failures never break the form', () => {
		const storage = new MemoryStorage()
		const draft = createFormDraft('intake', { fields: ['name'] }, app, storage)
		draft.save({ name: 'Ada' })
		draft.clear()
		expect(storage.length).toBe(0)
		const broken: FormDraftStorage = {
			getItem: () => {
				throw new Error('denied')
			},
			setItem: () => {
				throw new Error('quota')
			},
			removeItem: () => {
				throw new Error('denied')
			},
			length: 0,
			key: () => null,
		}
		const fragile = createFormDraft('intake', { fields: ['name'] }, app, broken)
		expect(() => fragile.save({ name: 'x' })).not.toThrow()
		expect(fragile.restore()).toBeNull()
		expect(() => fragile.clear()).not.toThrow()
	})

	test('formDraftAppInfo reads the base name, encryption and schema defensively', () => {
		expect(formDraftAppInfo(null)).toEqual({ dbName: 'kora-db', encrypted: false, schema: null })
		expect(
			formDraftAppInfo({
				storeInfo: () => ({ baseName: 'clinic' }),
				encryption: { getStatus: () => ({}) },
				getStore: () => {
					throw new Error('not ready')
				},
			}),
		).toEqual({ dbName: 'clinic', encrypted: true, schema: null })
		expect(
			formDraftAppInfo({ encryption: null, getStore: () => ({ getSchema: () => schema }) }).schema,
		).toBe(schema)
	})
})
