import { describe, expect, test, vi } from 'vitest'
import { defineSchema } from '../schema/define'
import { t } from '../schema/types'
import {
	type FormDraftStorage,
	clearFormDrafts,
	createFormDraft,
	describeFormDraftInput,
	formDraftAppInfo,
	formDraftPrefix,
	formValuesEqual,
	mergeRestoredDraft,
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
/** Every field bound to a plain text input. */
const text = () => ({ type: 'text' })

describe('form drafts (version gate section 6.1)', () => {
	test('rule 1: opt-in and allow-listed; an unlisted field is never stored', () => {
		const storage = new MemoryStorage()
		const draft = createFormDraft('intake', { fields: ['name'] }, app, storage)
		draft.save({ name: 'Ada', notes: 'unlisted' } as Record<string, unknown>, text)
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
		draft.save({ ssn: '000' }, text)
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
		draft.save({ name: 'Ada' }, text)
		expect(storage.length).toBe(0)
		known = schema
		draft.save({ name: 'Ada' }, text)
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
		draft.save({ name: 'Ada' }, text)
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
		draft.save({ name: 'Ada' }, text)
		expect(setItem).not.toHaveBeenCalled()
		// A plaintext draft left by an earlier unencrypted session is removed, not restored.
		storage.items.set(
			'kora-draft:clinic:intake',
			JSON.stringify({ v: 1, user: null, values: { name: 'x' } }),
		)
		expect(draft.restore(text)).toBeNull()
		expect(storage.length).toBe(0)
	})

	test('rule 4: a restored draft is consumed; a second restore gets nothing', () => {
		const storage = new MemoryStorage()
		const draft = createFormDraft('intake', { fields: ['name'] }, app, storage)
		draft.save({ name: 'Ada' }, text)
		expect(draft.restore(text)).toEqual({ name: 'Ada' })
		expect(storage.length).toBe(0)
		expect(draft.restore(text)).toBeNull()
	})

	test('rule 4: a draft of another user is not restored and is removed', () => {
		const storage = new MemoryStorage()
		createFormDraft('intake', { fields: ['name'], userId: 'alice' }, app, storage).save(
			{
				name: 'A',
			},
			text,
		)
		const bob = createFormDraft('intake', { fields: ['name'], userId: 'bob' }, app, storage)
		expect(bob.restore(text)).toBeNull()
		expect(storage.length).toBe(0)
	})

	test('rule 4: sign-out clears every draft of the database and nothing else', () => {
		const storage = new MemoryStorage()
		createFormDraft('a', { fields: ['name'] }, app, storage).save({ name: '1' }, text)
		createFormDraft('b', { fields: ['name'] }, app, storage).save({ name: '2' }, text)
		createFormDraft('a', { fields: ['name'] }, { ...app, dbName: 'other' }, storage).save(
			{
				name: '3',
			},
			text,
		)
		storage.setItem('unrelated', 'keep')
		expect(clearFormDrafts('clinic', storage)).toBe(2)
		expect([...storage.items.keys()].sort()).toEqual([`${formDraftPrefix('other')}a`, 'unrelated'])
	})

	test('database names are delimited: clearing "a" never touches "a:b"', () => {
		const storage = new MemoryStorage()
		createFormDraft('f', { fields: ['name'] }, { ...app, dbName: 'a' }, storage).save(
			{ name: '1' },
			text,
		)
		createFormDraft('f', { fields: ['name'] }, { ...app, dbName: 'a:b' }, storage).save(
			{
				name: '2',
			},
			text,
		)
		expect(clearFormDrafts('a', storage)).toBe(1)
		expect(storage.length).toBe(1)
	})

	test('clear() after a successful submit; storage failures never break the form', () => {
		const storage = new MemoryStorage()
		const draft = createFormDraft('intake', { fields: ['name'] }, app, storage)
		draft.save({ name: 'Ada' }, text)
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
		expect(() => fragile.save({ name: 'x' }, text)).not.toThrow()
		expect(fragile.restore(text)).toBeNull()
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

	test('fail closed: a listed field with no resolvable input is not drafted unless safe', () => {
		const storage = new MemoryStorage()
		const draft = createFormDraft(
			'intake',
			{ fields: ['name', 'tags'], safe: ['tags'] },
			{ ...app, schema: null },
			storage,
		)
		// `name` was set from code (no input), `tags` is vouched for.
		draft.save({ name: 'Ada', tags: ['x'] }, () => undefined)
		expect(JSON.parse(storage.getItem('kora-draft:clinic:intake') ?? '{}').values).toEqual({
			tags: ['x'],
		})
		draft.save({ name: 'Ada', tags: ['x'] })
		expect(JSON.parse(storage.getItem('kora-draft:clinic:intake') ?? '{}').values).toEqual({
			tags: ['x'],
		})
	})

	test('a field once bound to a password input is never drafted again (show-password toggle); autocomplete tokens count', () => {
		const storage = new MemoryStorage()
		const draft = createFormDraft(
			'login',
			{ fields: ['password', 'code', 'card', 'user'] },
			{ ...app, schema: null },
			storage,
		)
		draft.save({ password: 'p', code: '1', card: '4', user: 'u' }, (field) =>
			field === 'password'
				? { type: 'password' }
				: field === 'code'
					? { type: 'text', autocomplete: 'one-time-code' }
					: field === 'card'
						? { type: 'text', autocomplete: 'billing cc-number' }
						: { type: 'text' },
		)
		// The user toggled "show password": the input is a text input now.
		draft.save({ password: 'p', code: '1', card: '4', user: 'u' }, text)
		expect(JSON.parse(storage.getItem('kora-draft:clinic:login') ?? '{}').values).toEqual({
			user: 'u',
		})
	})

	test('describeFormDraftInput resolves the control at or inside a wrapper; unresolvable is undefined', () => {
		const control = (attrs: Record<string, string>, type?: string) => ({
			type,
			getAttribute: (name: string) => attrs[name] ?? null,
			hasAttribute: (name: string) => name in attrs,
			matches: () => true,
			closest: () => null,
		})
		const wrapper = (children: unknown[], attrs: Record<string, string> = {}) => ({
			getAttribute: (name: string) => attrs[name] ?? null,
			hasAttribute: (name: string) => name in attrs,
			matches: () => false,
			querySelectorAll: () => children,
		})
		expect(describeFormDraftInput(null)).toBeUndefined()
		expect(describeFormDraftInput(wrapper([]))).toBeUndefined()
		expect(describeFormDraftInput(control({}, 'text'))).toMatchObject({ type: 'text' })
		// No type attribute and no property: a text input.
		expect(describeFormDraftInput(control({}))).toMatchObject({ type: 'text' })
		// A custom PasswordInput whose ref is its wrapper <div>.
		expect(
			describeFormDraftInput(wrapper([control({}, 'hidden'), control({}, 'password')])),
		).toMatchObject({ type: 'password' })
		expect(
			describeFormDraftInput(wrapper([control({}, 'text')], { 'data-kora-sensitive': '' })),
		).toMatchObject({ sensitive: true })
	})

	test('rule 5: while the user is loading (undefined) nothing is restored, consumed or saved', () => {
		const storage = new MemoryStorage()
		createFormDraft('intake', { fields: ['name'], userId: 'alice' }, app, storage).save(
			{ name: 'A' },
			text,
		)
		const session: { user: string | null | undefined } = { user: undefined }
		const draft = createFormDraft(
			'intake',
			{ fields: ['name'], userId: () => session.user },
			app,
			storage,
		)
		expect(draft.restore(text)).toBeNull()
		expect(storage.length).toBe(1)
		draft.save({ name: 'typed while loading' }, text)
		expect(storage.getItem('kora-draft:clinic:intake')).toContain('"A"')
		// The session loaded: the same user gets the draft back.
		session.user = 'alice'
		expect(draft.restore(text)).toEqual({ name: 'A' })
		expect(storage.length).toBe(0)
		// A value `userId: undefined` is the same "unknown" (an omitted userId means no users).
		createFormDraft('intake', { fields: ['name'] }, app, storage).save({ name: 'B' }, text)
		const loading = createFormDraft('intake', { fields: ['name'], userId: undefined }, app, storage)
		expect(loading.restore(text)).toBeNull()
		expect(storage.length).toBe(1)
		// A known different user: removed, never restored.
		expect(
			createFormDraft('intake', { fields: ['name'], userId: 'bob' }, app, storage).restore(text),
		).toBeNull()
		expect(storage.length).toBe(0)
	})

	test('dotted sensitive paths remove nested values (each array element too)', () => {
		const storage = new MemoryStorage()
		const draft = createFormDraft(
			'intake',
			{ fields: ['answers', 'contacts'], sensitive: ['answers.ssn', 'contacts.phone'] },
			{ ...app, schema: null },
			storage,
		)
		const answers = { ssn: '000', diagnosis: { code: 'x' } }
		draft.save(
			{
				answers,
				contacts: [
					{ name: 'a', phone: '1' },
					{ name: 'b', phone: '2' },
				],
			},
			text,
		)
		expect(JSON.parse(storage.getItem('kora-draft:clinic:intake') ?? '{}').values).toEqual({
			answers: { diagnosis: { code: 'x' } },
			contacts: [{ name: 'a' }, { name: 'b' }],
		})
		// The form's own value is untouched.
		expect(answers.ssn).toBe('000')
	})

	test('a sensitive, allowSensitive or safe entry that is not a listed field warns', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		createFormDraft(
			'warned-form',
			{ fields: ['name'], sensitive: ['nmae', 'name'], allowSensitive: ['x'], safe: ['y.z'] },
			app,
			new MemoryStorage(),
		)
		const messages = warn.mock.calls.map((call) => String(call[0]))
		expect(messages.filter((m) => m.includes('warned-form'))).toHaveLength(3)
		expect(messages.some((m) => m.includes('"nmae" in sensitive'))).toBe(true)
		warn.mockRestore()
	})

	test('noteInput: a field observed as a password before any save is never drafted', () => {
		const storage = new MemoryStorage()
		const draft = createFormDraft('login', { fields: ['pw'] }, { ...app, schema: null }, storage)
		draft.noteInput('pw', { type: 'password' })
		draft.save({ pw: 'hunter2' }, text)
		expect(storage.length).toBe(0)
	})

	test('allowSensitive keeps a nested sensitive path: the whole field, or that dotted path (Codex re-audit)', () => {
		const answers = { ssn: '000', diagnosis: 'x' }
		for (const allowSensitive of [['answers'], ['answers.ssn']]) {
			const storage = new MemoryStorage()
			createFormDraft(
				'intake',
				{ fields: ['answers'], sensitive: ['answers.ssn'], allowSensitive },
				{ ...app, schema: null },
				storage,
			).save({ answers }, text)
			expect(JSON.parse(storage.getItem('kora-draft:clinic:intake') ?? '{}').values).toEqual({
				answers,
			})
		}
	})

	test('clearFormDrafts takes the app (its store base name) as documented, or a database name (Codex re-audit)', () => {
		const storage = new MemoryStorage()
		createFormDraft('a', { fields: ['name'] }, app, storage).save({ name: '1' }, text)
		const kora = { storeInfo: () => ({ baseName: 'clinic' }), encryption: null }
		expect(clearFormDrafts(kora, storage)).toBe(1)
		expect(storage.length).toBe(0)
	})

	test('clear() while the user is unknown keeps the stored draft (Codex re-audit)', () => {
		const storage = new MemoryStorage()
		createFormDraft('intake', { fields: ['name'], userId: 'alice' }, app, storage).save(
			{ name: 'A' },
			text,
		)
		const loading = createFormDraft('intake', { fields: ['name'], userId: undefined }, app, storage)
		loading.clear()
		expect(storage.length).toBe(1)
	})

	test('formValuesEqual never throws (bigint, cycles); mergeRestoredDraft keeps typed fields', () => {
		const cyclic: Record<string, unknown> = {}
		cyclic.self = cyclic
		expect(formValuesEqual(1n, 1n)).toBe(true)
		expect(formValuesEqual(cyclic, {})).toBe(false)
		expect(formValuesEqual({ a: 1 }, { a: 1 })).toBe(true)
		expect(
			mergeRestoredDraft(
				{ title: 'typed', body: '' },
				{ title: '', body: '' },
				{ title: 's', body: 'b' },
			),
		).toEqual({ title: 'typed', body: 'b' })
	})
})
