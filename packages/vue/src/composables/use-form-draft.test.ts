import { defineSchema, t } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { defineComponent, h, nextTick, ref, shallowRef } from 'vue'
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
				nested = useFormDraft(
					'address',
					{ address: { city: '' } },
					// Set from code, no input bound: drafted only because it is vouched for.
					{ fields: ['address'], safe: ['address'] },
				)
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

	test('a loading user (undefined) neither restores nor removes the draft; it is restored once known', async () => {
		const ctx = context()
		sessionStorage.setItem(
			'kora-draft:notes-db:user-note',
			JSON.stringify({ v: 1, user: 'alice', values: { title: 'saved' } }),
		)
		const user = ref<string | null | undefined>(undefined)
		let api: ReturnType<typeof useFormDraft<{ title: string }>> | null = null
		const UserForm = defineComponent({
			setup() {
				const draft = useFormDraft('user-note', { title: '' }, { fields: ['title'], userId: user })
				api = draft
				return () => h('input', { ref: draft.fieldRef('title'), type: 'text' })
			},
		})
		mount(UserForm, { global: { provide: { [koraContextKey as symbol]: shallowRef(ctx.value) } } })
		await nextTick()
		const draft = api as ReturnType<typeof useFormDraft<{ title: string }>> | null
		expect(draft?.values.title).toBe('')
		expect(sessionStorage.getItem('kora-draft:notes-db:user-note')).toContain('saved')
		user.value = 'alice'
		await nextTick()
		await nextTick()
		expect(draft?.values.title).toBe('saved')
		expect(sessionStorage.getItem('kora-draft:notes-db:user-note')).toBeNull()
	})

	test('a component ref reads the control inside it: a wrapped password input is not drafted, a wrapped text input is', async () => {
		const ctx = context()
		type Wrapped = { secret: string; note: string }
		let api: ReturnType<typeof useFormDraft<Wrapped>> | null = null
		const Wrapper = defineComponent({
			props: { type: { type: String, required: true } },
			setup(props) {
				return () => h('div', [h('input', { type: props.type })])
			},
		})
		const WrapperForm = defineComponent({
			setup() {
				const draft = useFormDraft<Wrapped>(
					'wrapped',
					{ secret: '', note: '' },
					{ fields: ['secret', 'note'] },
				)
				api = draft
				return () =>
					h('form', [
						h(Wrapper, { type: 'password', ref: draft.fieldRef('secret') }),
						h(Wrapper, { type: 'text', ref: draft.fieldRef('note') }),
					])
			},
		})
		mount(WrapperForm, {
			global: { provide: { [koraContextKey as symbol]: shallowRef(ctx.value) } },
		})
		await nextTick()
		const draft = api as ReturnType<typeof useFormDraft<Wrapped>> | null
		if (draft) {
			draft.values.secret = 'hunter2'
			draft.values.note = 'kept'
		}
		await nextTick()
		expect(
			JSON.parse(sessionStorage.getItem('kora-draft:notes-db:wrapped') ?? '{}').values,
		).toEqual({ note: 'kept' })
	})

	test('"show password" toggled before typing: the password never reaches sessionStorage', async () => {
		const ctx = context()
		const shown = ref(false)
		type Login = { pw: string; user: string }
		let api: ReturnType<typeof useFormDraft<Login>> | null = null
		const LoginForm = defineComponent({
			setup() {
				const draft = useFormDraft<Login>('login', { pw: '', user: '' }, { fields: ['pw', 'user'] })
				api = draft
				return () =>
					h('form', [
						h('input', { ref: draft.fieldRef('user'), type: 'text' }),
						h('input', { ref: draft.fieldRef('pw'), type: shown.value ? 'text' : 'password' }),
					])
			},
		})
		mount(LoginForm, { global: { provide: { [koraContextKey as symbol]: shallowRef(ctx.value) } } })
		await nextTick()
		shown.value = true
		await nextTick()
		const draft = api as ReturnType<typeof useFormDraft<Login>> | null
		if (draft) {
			draft.values.pw = 'hunter2'
			draft.values.user = 'ada'
		}
		await nextTick()
		const stored = sessionStorage.getItem('kora-draft:notes-db:login') ?? ''
		expect(stored).not.toContain('hunter2')
		expect(JSON.parse(stored).values).toEqual({ user: 'ada' })
	})

	describe('users, clearing, values (Codex re-audit)', () => {
		const KEY_U = 'kora-draft:notes-db:user-form'
		type U = { title: string; body: string }
		const mountForm = (userId: unknown, ctx = context()) => {
			let api: ReturnType<typeof useFormDraft<U>> | null = null
			const Form = defineComponent({
				setup() {
					const draft = useFormDraft<U>(
						'user-form',
						{ title: '', body: '' },
						{ fields: ['title', 'body'], userId: userId as never },
					)
					api = draft
					return () =>
						h('form', [
							h('input', { ref: draft.fieldRef('title'), type: 'text' }),
							h('input', { ref: draft.fieldRef('body'), type: 'text' }),
						])
				},
			})
			mount(Form, { global: { provide: { [koraContextKey as symbol]: shallowRef(ctx.value) } } })
			return { draft: () => api as ReturnType<typeof useFormDraft<U>>, ctx }
		}
		const stored = () => sessionStorage.getItem(KEY_U)
		const settle = async () => {
			await nextTick()
			await nextTick()
		}

		test("a plain userId getter switching accounts resets the form; Alice's values are never stored under Bob", async () => {
			let current: string | null | undefined = 'alice'
			const { draft } = mountForm(() => current)
			await settle()
			draft().values.title = 'alice private note'
			await settle()
			expect(stored()).toContain('"alice"')
			current = 'bob'
			draft().values.body = 'x'
			await settle()
			expect(draft().values.title).toBe('')
			expect(stored() ?? '').not.toMatch(/"user":"bob".*alice private note/)
		})

		test('fields typed while the session loads win over the stored draft; untouched fields are restored', async () => {
			sessionStorage.setItem(
				KEY_U,
				JSON.stringify({
					v: 1,
					user: 'alice',
					values: { title: 'saved title', body: 'saved body' },
				}),
			)
			const user = ref<string | null | undefined>(undefined)
			const { draft } = mountForm(user)
			await settle()
			draft().values.title = 'typed while loading'
			await settle()
			user.value = 'alice'
			await settle()
			expect(draft().values.title).toBe('typed while loading')
			expect(draft().values.body).toBe('saved body')
		})

		test("alice, loading, bob: Alice's values never carry over to Bob", async () => {
			const user = ref<string | null | undefined>('alice')
			const { draft } = mountForm(user)
			await settle()
			draft().values.title = 'alice private note'
			await settle()
			user.value = undefined
			await settle()
			user.value = 'bob'
			await settle()
			expect(draft().values.title).toBe('')
			draft().values.body = 'bob'
			await settle()
			expect(stored() ?? '').not.toContain('alice private note')
		})

		test('while the user is unknown, a form back at its initial values or a reload never deletes the stored draft', async () => {
			const saved = JSON.stringify({ v: 1, user: 'alice', values: { title: 'saved title' } })
			sessionStorage.setItem(KEY_U, saved)
			const { draft, ctx } = mountForm(ref<string | null | undefined>(undefined))
			await settle()
			draft().values.title = 'x'
			await settle()
			draft().values.title = ''
			await settle()
			ctx.events.emit({ type: 'app:before-build-reload' })
			expect(stored()).toBe(saved)
		})

		test('values with a bigint or a cycle never throw from the watcher; the form keeps working', async () => {
			const errors: unknown[] = []
			let api: ReturnType<typeof useFormDraft<{ n: unknown }>> | null = null
			const Odd = defineComponent({
				setup() {
					api = useFormDraft<{ n: unknown }>('odd', { n: 0 }, { fields: ['n'], safe: ['n'] })
					return () => h('div')
				},
			})
			mount(Odd, {
				global: {
					provide: { [koraContextKey as symbol]: shallowRef(context().value) },
					config: { errorHandler: (error) => errors.push(error) },
				},
			})
			await settle()
			const draft = api as ReturnType<typeof useFormDraft<{ n: unknown }>> | null
			if (draft) draft.values.n = 10n
			await settle()
			const cyclic: Record<string, unknown> = {}
			cyclic.self = cyclic
			if (draft) draft.values.n = cyclic
			await settle()
			expect(errors).toEqual([])
		})
	})

	test('sibling: a wrapper in a parent component gaining data-kora-sensitive removes the stored value at once', async () => {
		const sensitive = ref(false)
		let api: ReturnType<typeof useFormDraft<{ note: string }>> | null = null
		const Child = defineComponent({
			setup() {
				const draft = useFormDraft<{ note: string }>('ancestor', { note: '' }, { fields: ['note'] })
				api = draft
				return () => h('input', { ref: draft.fieldRef('note'), type: 'text' })
			},
		})
		const Parent = defineComponent({
			setup() {
				return () => h('div', sensitive.value ? { 'data-kora-sensitive': '' } : {}, [h(Child)])
			},
		})
		mount(Parent, {
			attachTo: document.body,
			global: { provide: { [koraContextKey as symbol]: shallowRef(context().value) } },
		})
		await nextTick()
		const draft = api as ReturnType<typeof useFormDraft<{ note: string }>> | null
		if (draft) draft.values.note = 'private'
		await nextTick()
		expect(sessionStorage.getItem('kora-draft:notes-db:ancestor')).toContain('private')
		sensitive.value = true
		await nextTick()
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(sessionStorage.getItem('kora-draft:notes-db:ancestor') ?? '').not.toContain('private')
	})
})
