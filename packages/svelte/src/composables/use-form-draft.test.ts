import { defineSchema, t } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { get, writable } from 'svelte/store'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { KoraAppLike } from '../types'
import { useFormDraft } from './use-form-draft'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { title: t.string(), token: t.secret() } } },
})
const KEY = 'kora-draft:notes-db:new-note'

function app(options: { encrypted?: boolean } = {}): KoraAppLike & { events: SimpleEventEmitter } {
	return {
		ready: Promise.resolve(),
		events: new SimpleEventEmitter(),
		getStore: () => ({ getSchema: () => schema }),
		getSyncEngine: () => null,
		storeInfo: () => ({ baseName: 'notes-db' }),
		encryption: options.encrypted ? {} : null,
	} as unknown as KoraAppLike & { events: SimpleEventEmitter }
}

class FakeInput {
	private readonly attributes = new Map<string, string>()
	private readonly listeners = new Set<() => void>()
	constructor(type: string) {
		this.attributes.set('type', type)
	}
	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null
	}
	hasAttribute(name: string): boolean {
		return this.attributes.has(name)
	}
	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value)
	}
	matches(selector: string): boolean {
		return selector.includes('input')
	}
	addEventListener(_type: 'input', listener: () => void): void {
		this.listeners.add(listener)
	}
	removeEventListener(_type: 'input', listener: () => void): void {
		this.listeners.delete(listener)
	}
	input(): void {
		for (const listener of this.listeners) listener()
	}
}

function input(type: string): FakeInput {
	return new FakeInput(type)
}

type Values = { title: string; pin: string; token: string }
const initial: Values = { title: '', pin: '', token: '' }
const options = { fields: ['title', 'pin', 'token'] as const, collection: 'notes' }

beforeEach(() => {
	sessionStorage.clear()
})

describe('useFormDraft (Svelte)', () => {
	test('drafts listed, non-secret, non-password fields; restores and consumes; clear()', () => {
		const kora = app()
		const draft = useFormDraft<Values>(
			'new-note',
			initial,
			{ ...options, fields: [...options.fields] },
			kora,
		)
		draft.field(input('text'), 'title')
		draft.field(input('password'), 'pin')
		draft.field(input('text'), 'token')
		draft.restore()
		draft.set({ title: 'Groceries', pin: '1234', token: 'tok' })
		expect(JSON.parse(sessionStorage.getItem(KEY) ?? '{}').values).toEqual({ title: 'Groceries' })
		draft.destroy()

		const again = useFormDraft<Values>(
			'new-note',
			initial,
			{ ...options, fields: [...options.fields] },
			kora,
		)
		again.field(input('text'), 'title')
		again.restore()
		expect(get(again).title).toBe('Groceries')
		expect(get(again.restored)).toBe(true)
		expect(sessionStorage.getItem(KEY)).toBeNull()
		again.clear()
		expect(get(again).title).toBe('')
		expect(sessionStorage.getItem(KEY)).toBeNull()
	})

	test('with encryption enabled nothing is written to sessionStorage', () => {
		const setItem = vi.spyOn(Storage.prototype, 'setItem')
		const draft = useFormDraft<Values>(
			'new-note',
			initial,
			{ ...options, fields: [...options.fields] },
			app({ encrypted: true }),
		)
		draft.restore()
		draft.set({ ...initial, title: 'plan' })
		expect(setItem).not.toHaveBeenCalled()
		setItem.mockRestore()
	})

	test('an input switched to type="password" is removed from the draft on its next input', () => {
		const draft = useFormDraft<Values>(
			'new-note',
			initial,
			{ ...options, fields: [...options.fields] },
			app(),
		)
		const pin = input('text')
		draft.field(pin, 'pin')
		draft.restore()
		draft.set({ ...initial, pin: '9999' })
		expect(sessionStorage.getItem(KEY)).toContain('9999')
		pin.setAttribute('type', 'password')
		pin.input()
		expect(sessionStorage.getItem(KEY) ?? '').not.toContain('9999')
	})

	test('app:before-build-reload saves the latest values', () => {
		const kora = app()
		const draft = useFormDraft<Values>(
			'new-note',
			initial,
			{ ...options, fields: [...options.fields] },
			kora,
		)
		draft.field(input('text'), 'title')
		draft.restore()
		draft.set({ ...initial, title: 'last' })
		sessionStorage.clear()
		kora.events.emit({ type: 'app:before-build-reload' })
		expect(sessionStorage.getItem(KEY)).toContain('last')
		draft.destroy()
	})

	test('a reactive switch to type="password" removes the stored value without an input event', async () => {
		const draft = useFormDraft<Values>(
			'new-note',
			initial,
			{ ...options, fields: [...options.fields] },
			app(),
		)
		const doc = (
			globalThis as unknown as {
				document: { createElement(tag: string): FakeInputLike }
			}
		).document
		const pin = doc.createElement('input')
		pin.setAttribute('type', 'text')
		draft.field(pin, 'pin')
		draft.restore()
		draft.set({ ...initial, pin: '9999' })
		expect(sessionStorage.getItem(KEY)).toContain('9999')
		pin.setAttribute('type', 'password')
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(sessionStorage.getItem(KEY) ?? '').not.toContain('9999')
		draft.destroy()
	})
})

describe('useFormDraft (Svelte): users and wrappers', () => {
	test('a user store that is loading (undefined) neither restores nor removes; known: restored, typed text kept', () => {
		sessionStorage.setItem(
			'kora-draft:notes-db:user-note',
			JSON.stringify({ v: 1, user: 'alice', values: { title: 'saved' } }),
		)
		const user = writable<string | null | undefined>(undefined)
		const draft = useFormDraft(
			'user-note',
			{ title: '', body: '' },
			{ fields: ['title', 'body'], userId: user },
			app(),
		)
		draft.field(input('text'), 'title')
		draft.field(input('text'), 'body')
		draft.restore()
		expect(get(draft).title).toBe('')
		draft.set({ title: '', body: 'typed while loading' })
		expect(sessionStorage.getItem('kora-draft:notes-db:user-note')).toContain('saved')
		user.set('alice')
		expect(get(draft)).toEqual({ title: 'saved', body: 'typed while loading' })
		expect(get(draft.restored)).toBe(true)
		// Another user: the form starts over; their own draft (none) is restored.
		draft.setUser('bob')
		expect(get(draft)).toEqual({ title: '', body: '' })
		draft.destroy()
	})

	test('on a wrapper element the control inside it is read; no control is not drafted unless safe', () => {
		const wrapper = (control: FakeInput | null) => ({
			getAttribute: () => null,
			hasAttribute: () => false,
			matches: () => false,
			querySelectorAll: () => (control ? [control] : []),
			addEventListener: () => {},
			removeEventListener: () => {},
		})
		const draft = useFormDraft(
			'wrapped',
			{ secret: '', plain: '', free: '' },
			{ fields: ['secret', 'plain', 'free'], safe: ['free'] },
			app(),
		)
		draft.field(wrapper(input('password')), 'secret')
		draft.field(wrapper(null), 'plain')
		draft.restore()
		draft.set({ secret: 'hunter2', plain: 'x', free: 'vouched' })
		expect(
			JSON.parse(sessionStorage.getItem('kora-draft:notes-db:wrapped') ?? '{}').values,
		).toEqual({ free: 'vouched' })
		draft.destroy()
	})
})

describe('useFormDraft (Svelte): show password', () => {
	test('"show password" toggled before typing: the password never reaches sessionStorage', () => {
		const draft = useFormDraft('login', { pw: '', user: '' }, { fields: ['pw', 'user'] }, app())
		const pw = input('password')
		draft.field(input('text'), 'user')
		draft.field(pw, 'pw')
		draft.restore()
		// Toggled to text before the first keystroke, then typed.
		pw.setAttribute('type', 'text')
		draft.set({ pw: 'hunter2', user: 'ada' })
		pw.input()
		const stored = sessionStorage.getItem('kora-draft:notes-db:login') ?? ''
		expect(stored).not.toContain('hunter2')
		expect(JSON.parse(stored).values).toEqual({ user: 'ada' })
		draft.destroy()
	})
})

describe('useFormDraft (Svelte): users, clearing, values (Codex re-audit)', () => {
	const KEY_U = 'kora-draft:notes-db:user-form'
	type U = { title: string; body: string }
	const make = (userId: unknown, kora = app()) => {
		const draft = useFormDraft<U>(
			'user-form',
			{ title: '', body: '' },
			{ fields: ['title', 'body'], userId: userId as never },
			kora,
		)
		draft.field(input('text'), 'title')
		draft.field(input('text'), 'body')
		draft.restore()
		return draft
	}
	const stored = () => sessionStorage.getItem(KEY_U)

	test("a userId getter switching accounts resets the form; Alice's values are never stored under Bob", () => {
		let current: string | null | undefined = 'alice'
		const draft = make(() => current)
		draft.set({ title: 'alice private note', body: '' })
		expect(stored()).toContain('"alice"')
		current = 'bob'
		draft.update((values) => ({ ...values, body: 'x' }))
		expect(get(draft)).toEqual({ title: '', body: '' })
		expect(stored() ?? '').not.toMatch(/"user":"bob".*alice private note/)
		draft.destroy()
	})

	test('fields typed while the session loads win over the stored draft; untouched fields are restored', () => {
		sessionStorage.setItem(
			KEY_U,
			JSON.stringify({ v: 1, user: 'alice', values: { title: 'saved title', body: 'saved body' } }),
		)
		const user = writable<string | null | undefined>(undefined)
		const draft = make(user)
		draft.set({ title: 'typed while loading', body: '' })
		user.set('alice')
		expect(get(draft)).toEqual({ title: 'typed while loading', body: 'saved body' })
		draft.destroy()
	})

	test("alice, loading, bob: Alice's values never carry over to Bob", () => {
		const user = writable<string | null | undefined>('alice')
		const draft = make(user)
		draft.set({ title: 'alice private note', body: '' })
		user.set(undefined)
		user.set('bob')
		expect(get(draft)).toEqual({ title: '', body: '' })
		draft.update((values) => ({ ...values, body: 'bob' }))
		expect(stored() ?? '').not.toContain('alice private note')
		draft.destroy()
	})

	test('while the user is unknown, a form back at its initial values or a reload never deletes the stored draft', () => {
		const saved = JSON.stringify({ v: 1, user: 'alice', values: { title: 'saved title' } })
		sessionStorage.setItem(KEY_U, saved)
		const kora = app()
		const draft = make(writable<string | null | undefined>(undefined), kora)
		draft.set({ title: 'x', body: '' })
		draft.set({ title: '', body: '' })
		kora.events.emit({ type: 'app:before-build-reload' })
		expect(stored()).toBe(saved)
		draft.clear()
		expect(stored()).toBe(saved)
		draft.destroy()
	})

	test('values with a bigint or a cycle never throw from set(); the form keeps working', () => {
		const draft = useFormDraft<{ n: unknown }>(
			'odd',
			{ n: 0 },
			{ fields: ['n'], safe: ['n'] },
			app(),
		)
		draft.restore()
		const cyclic: Record<string, unknown> = {}
		cyclic.self = cyclic
		expect(() => draft.set({ n: 10n })).not.toThrow()
		expect(() => draft.set({ n: cyclic })).not.toThrow()
		expect(get(draft).n).toBe(cyclic)
		draft.destroy()
	})

	test('an ancestor that gains data-kora-sensitive removes the stored value at once', async () => {
		type El = FakeInputLike & { append(child: unknown): void; remove(): void }
		const doc = (
			globalThis as unknown as {
				document: { createElement(tag: string): El; body: { append(child: unknown): void } }
			}
		).document
		const wrapper = doc.createElement('div')
		const field = doc.createElement('input')
		field.setAttribute('type', 'text')
		wrapper.append(field)
		doc.body.append(wrapper)
		const draft = useFormDraft<{ note: string }>(
			'ancestor',
			{ note: '' },
			{ fields: ['note'] },
			app(),
		)
		draft.field(field, 'note')
		draft.restore()
		draft.set({ note: 'private' })
		expect(sessionStorage.getItem('kora-draft:notes-db:ancestor')).toContain('private')
		wrapper.setAttribute('data-kora-sensitive', '')
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(sessionStorage.getItem('kora-draft:notes-db:ancestor') ?? '').not.toContain('private')
		wrapper.remove()
		draft.destroy()
	})
})

interface FakeInputLike {
	getAttribute(name: string): string | null
	hasAttribute(name: string): boolean
	setAttribute(name: string, value: string): void
	addEventListener(type: 'input', listener: () => void): void
	removeEventListener(type: 'input', listener: () => void): void
}
