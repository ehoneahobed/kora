import { defineSchema, t } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { defineComponent, h, nextTick, shallowRef } from 'vue'
import { koraContextKey } from '../context'
import type { KoraContextValue } from '../types'
import { useFormDraft } from './use-form-draft'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { title: t.string(), token: t.secret() } } },
})
const KEY = 'kora-draft:notes-db:new-note'

function context(options: { encrypted?: boolean } = {}): {
	value: KoraContextValue
	events: SimpleEventEmitter
} {
	const events = new SimpleEventEmitter()
	const app = {
		ready: Promise.resolve(),
		events,
		getStore: () => ({ getSchema: () => schema }),
		getSyncEngine: () => null,
		storeInfo: () => ({ baseName: 'notes-db' }),
		encryption: options.encrypted ? {} : null,
	}
	return {
		value: { app, events, store: app.getStore(), syncEngine: null } as unknown as KoraContextValue,
		events,
	}
}

type Values = { title: string; pin: string; token: string }
let latest: ReturnType<typeof useFormDraft<Values>> | null = null

function form(ctx: KoraContextValue, pinType = 'password') {
	const Form = defineComponent({
		props: { pinType: { type: String, default: pinType } },
		setup(props) {
			const draft = useFormDraft<Values>(
				'new-note',
				{ title: '', pin: '', token: '' },
				{ fields: ['title', 'pin', 'token'], collection: 'notes' },
			)
			latest = draft
			return () =>
				h('form', [
					h('input', { ref: draft.fieldRef('title'), type: 'text' }),
					h('input', { ref: draft.fieldRef('pin'), type: props.pinType }),
					h('input', { ref: draft.fieldRef('token'), type: 'text' }),
				])
		},
	})
	return mount(Form, { global: { provide: { [koraContextKey as symbol]: shallowRef(ctx) } } })
}

beforeEach(() => {
	sessionStorage.clear()
	latest = null
})
afterEach(() => {
	vi.restoreAllMocks()
})

describe('useFormDraft (Vue)', () => {
	test('drafts listed, non-secret, non-password fields; restores and consumes; clear()', async () => {
		const ctx = context()
		const first = form(ctx.value)
		await nextTick()
		if (!latest) throw new Error('not mounted')
		latest.values.title = 'Groceries'
		latest.values.pin = '1234'
		latest.values.token = 'tok'
		await nextTick()
		expect(JSON.parse(sessionStorage.getItem(KEY) ?? '{}').values).toEqual({ title: 'Groceries' })
		first.unmount()

		form(ctx.value)
		await nextTick()
		await nextTick()
		expect(latest?.values.title).toBe('Groceries')
		expect(latest?.restored.value).toBe(true)
		expect(sessionStorage.getItem(KEY)).toBeNull()
		latest?.clear()
		await nextTick()
		expect(latest?.values.title).toBe('')
		expect(sessionStorage.getItem(KEY)).toBeNull()
	})

	test('with encryption enabled nothing is written to sessionStorage', async () => {
		const setItem = vi.spyOn(Storage.prototype, 'setItem')
		form(context({ encrypted: true }).value)
		await nextTick()
		if (latest) latest.values.title = 'plan'
		await nextTick()
		expect(setItem).not.toHaveBeenCalled()
	})

	test('an input switched to type="password" is removed from the draft', async () => {
		const ctx = context()
		const view = form(ctx.value, 'text')
		await nextTick()
		if (latest) latest.values.pin = '9999'
		await nextTick()
		expect(sessionStorage.getItem(KEY)).toContain('9999')
		await view.setProps({ pinType: 'password' })
		await nextTick()
		expect(sessionStorage.getItem(KEY) ?? '').not.toContain('9999')
	})

	test('app:before-build-reload saves the latest values', async () => {
		const ctx = context()
		form(ctx.value)
		await nextTick()
		if (latest) latest.values.title = 'last'
		await nextTick()
		sessionStorage.clear()
		ctx.events.emit({ type: 'app:before-build-reload' })
		expect(sessionStorage.getItem(KEY)).toContain('last')
	})

	test('nested values never change the baseline; clear() restores it', async () => {
		const ctx = context()
		let nested: ReturnType<typeof useFormDraft<{ address: { city: string } }>> | null = null
		const Nested = defineComponent({
			setup() {
				nested = useFormDraft('address', { address: { city: '' } }, { fields: ['address'] })
				return () => h('div')
			},
		})
		mount(Nested, { global: { provide: { [koraContextKey as symbol]: shallowRef(ctx.value) } } })
		await nextTick()
		if (!nested) throw new Error('not mounted')
		const draft = nested as ReturnType<typeof useFormDraft<{ address: { city: string } }>>
		draft.values.address.city = 'Accra'
		await nextTick()
		expect(sessionStorage.getItem('kora-draft:notes-db:address')).toContain('Accra')
		draft.clear()
		await nextTick()
		expect(draft.values.address.city).toBe('')
		expect(sessionStorage.getItem('kora-draft:notes-db:address')).toBeNull()
	})
})
