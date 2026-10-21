import { defineSchema, t } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { get } from 'svelte/store'
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

interface FakeInputLike {
	getAttribute(name: string): string | null
	hasAttribute(name: string): boolean
	setAttribute(name: string, value: string): void
	addEventListener(type: 'input', listener: () => void): void
	removeEventListener(type: 'input', listener: () => void): void
}
