import { defineSchema, t } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import type { Store } from '@korajs/store'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { StrictMode, createElement, memo, useState } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { KoraProvider } from '../context/kora-context'
import type { KoraAppLike } from '../types'
import { useFormDraft } from './use-form-draft'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { title: t.string(), token: t.secret() } } },
})

function mockApp(
	options: { encrypted?: boolean } = {},
): KoraAppLike & { events: SimpleEventEmitter } {
	const events = new SimpleEventEmitter()
	return {
		ready: Promise.resolve(),
		events,
		getStore: () => ({ getSchema: () => schema }) as unknown as Store,
		getSyncEngine: () => null,
		storeInfo: () => ({ baseName: 'notes-db' }),
		encryption: options.encrypted ? { getStatus: () => ({}) } : null,
	} as unknown as KoraAppLike & { events: SimpleEventEmitter }
}

interface FormProps {
	fields?: Array<'title' | 'body' | 'pin' | 'token'>
	pinType?: string
	sensitiveBody?: boolean
	onReady?: (draft: ReturnType<typeof useFormDraft<Values>>) => void
}
type Values = { title: string; body: string; pin: string; token: string }

function Form({
	fields = ['title', 'body', 'pin', 'token'],
	pinType = 'password',
	sensitiveBody,
	onReady,
}: FormProps) {
	const draft = useFormDraft<Values>(
		'new-note',
		{ title: '', body: '', pin: '', token: '' },
		{ fields, collection: 'notes' },
	)
	onReady?.(draft)
	return createElement(
		'form',
		null,
		createElement('input', { 'aria-label': 'title', ...draft.bind('title') }),
		createElement('textarea', {
			'aria-label': 'body',
			...(sensitiveBody ? { 'data-kora-sensitive': '' } : {}),
			...draft.bind('body'),
		}),
		createElement('input', { 'aria-label': 'pin', type: pinType, ...draft.bind('pin') }),
		createElement('input', { 'aria-label': 'token', ...draft.bind('token') }),
		createElement('span', { 'data-testid': 'restored' }, String(draft.restored)),
	)
}

async function mount(app: KoraAppLike, props: FormProps = {}) {
	const view = render(createElement(KoraProvider, { app }, createElement(Form, props)))
	// KoraProvider renders its children once app.ready resolved.
	await screen.findByLabelText('title')
	await act(async () => {})
	return view
}

const KEY = 'kora-draft:notes-db:new-note'

beforeEach(() => {
	sessionStorage.clear()
})

afterEach(() => {
	cleanup()
	vi.restoreAllMocks()
})

describe('useFormDraft', () => {
	test('typed input survives a reload; the restored draft is consumed; clear() after submit', async () => {
		const app = mockApp()
		const first = await mount(app)
		fireEvent.change(screen.getByLabelText('title'), { target: { value: 'Groceries' } })
		fireEvent.change(screen.getByLabelText('pin'), { target: { value: '1234' } })
		fireEvent.change(screen.getByLabelText('token'), { target: { value: 'tok' } })
		const stored = JSON.parse(sessionStorage.getItem(KEY) ?? '{}')
		// Password and t.secret() fields are never written.
		expect(stored.values).toEqual({ title: 'Groceries', body: '' })
		first.unmount()

		let draft: ReturnType<typeof useFormDraft<Values>> | null = null
		await mount(app, {
			onReady: (d) => {
				draft = d
			},
		})
		expect((screen.getByLabelText('title') as HTMLInputElement).value).toBe('Groceries')
		expect(screen.getByTestId('restored').textContent).toBe('true')
		// Consumed on restore, rewritten only on the next change.
		expect(sessionStorage.getItem(KEY)).toBeNull()
		await act(async () => {
			draft?.clear()
		})
		expect((screen.getByLabelText('title') as HTMLInputElement).value).toBe('')
		expect(sessionStorage.getItem(KEY)).toBeNull()
	})

	test('a form that does not call it, and unlisted fields, write nothing', async () => {
		const app = mockApp()
		const setItem = vi.spyOn(Storage.prototype, 'setItem')
		await mount(app, { fields: ['title'] })
		fireEvent.change(screen.getByLabelText('body'), { target: { value: 'unlisted' } })
		expect(setItem).not.toHaveBeenCalled()
		fireEvent.change(screen.getByLabelText('title'), { target: { value: 'listed' } })
		expect(JSON.parse(sessionStorage.getItem(KEY) ?? '{}').values).toEqual({ title: 'listed' })
	})

	test('data-kora-sensitive inputs are excluded', async () => {
		await mount(mockApp(), { sensitiveBody: true })
		fireEvent.change(screen.getByLabelText('body'), { target: { value: 'diagnosis' } })
		fireEvent.change(screen.getByLabelText('title'), { target: { value: 't' } })
		expect(sessionStorage.getItem(KEY)).not.toContain('diagnosis')
	})

	test('an input switched to type="password" has its stored value removed at once', async () => {
		const app = mockApp()
		const view = await mount(app, { pinType: 'text' })
		fireEvent.change(screen.getByLabelText('pin'), { target: { value: '9999' } })
		expect(sessionStorage.getItem(KEY)).toContain('9999')
		view.rerender(
			createElement(KoraProvider, { app }, createElement(Form, { pinType: 'password' })),
		)
		expect(sessionStorage.getItem(KEY) ?? '').not.toContain('9999')
	})

	test('with encryption enabled nothing is ever written to sessionStorage', async () => {
		const setItem = vi.spyOn(Storage.prototype, 'setItem')
		await mount(mockApp({ encrypted: true }))
		fireEvent.change(screen.getByLabelText('title'), { target: { value: 'secret plan' } })
		expect(setItem).not.toHaveBeenCalled()
		expect(sessionStorage.length).toBe(0)
	})

	test('app:before-build-reload saves the latest values synchronously', async () => {
		const app = mockApp()
		await mount(app)
		fireEvent.change(screen.getByLabelText('title'), { target: { value: 'last words' } })
		sessionStorage.clear()
		app.events.emit({ type: 'app:before-build-reload' })
		expect(sessionStorage.getItem(KEY)).toContain('last words')
	})

	test('a new form key or user starts from the initial values; nothing is retagged', async () => {
		const app = mockApp()
		function Keyed({ userId }: { userId: string }) {
			const draft = useFormDraft('profile', { title: '' }, { fields: ['title'], userId })
			return createElement('input', { 'aria-label': 'title', ...draft.bind('title') })
		}
		const view = render(
			createElement(KoraProvider, { app }, createElement(Keyed, { userId: 'alice' })),
		)
		await screen.findByLabelText('title')
		fireEvent.change(screen.getByLabelText('title'), { target: { value: 'alice notes' } })
		const key = 'kora-draft:notes-db:profile'
		expect(JSON.parse(sessionStorage.getItem(key) ?? '{}').user).toBe('alice')
		sessionStorage.clear() // sign-out clears every draft
		view.rerender(createElement(KoraProvider, { app }, createElement(Keyed, { userId: 'bob' })))
		await act(async () => {})
		expect((screen.getByLabelText('title') as HTMLInputElement).value).toBe('')
		expect(sessionStorage.getItem(key)).toBeNull()
	})

	test('StrictMode: the restored draft survives the double effect run', async () => {
		const app = mockApp()
		sessionStorage.setItem(
			KEY,
			JSON.stringify({ v: 1, user: null, values: { title: 'kept', body: '' } }),
		)
		render(
			createElement(StrictMode, null, createElement(KoraProvider, { app }, createElement(Form))),
		)
		await screen.findByLabelText('title')
		expect((screen.getByLabelText('title') as HTMLInputElement).value).toBe('kept')
		expect(sessionStorage.getItem(KEY)).toBeNull()
	})

	test('bindChecked drafts a checkbox from its checked state', async () => {
		const app = mockApp()
		function Agree() {
			const draft = useFormDraft('agree', { done: false }, { fields: ['done'] })
			return createElement('input', {
				type: 'checkbox',
				'aria-label': 'done',
				...draft.bindChecked('done'),
			})
		}
		render(createElement(KoraProvider, { app }, createElement(Agree)))
		const box = (await screen.findByLabelText('done')) as HTMLInputElement
		fireEvent.click(box)
		expect(box.checked).toBe(true)
		expect(JSON.parse(sessionStorage.getItem('kora-draft:notes-db:agree') ?? '{}').values).toEqual({
			done: true,
		})
	})

	test('a loading session (userId undefined) neither restores nor removes the draft; it is restored once the user is known', async () => {
		const app = mockApp()
		sessionStorage.setItem(
			'kora-draft:notes-db:user-note',
			JSON.stringify({ v: 1, user: 'alice', values: { title: 'saved' } }),
		)
		function UserForm({ userId }: { userId: string | null | undefined }) {
			const draft = useFormDraft(
				'user-note',
				{ title: '' },
				{ fields: ['title'], collection: 'notes', userId },
			)
			return createElement('input', { 'aria-label': 'title', ...draft.bind('title') })
		}
		const view = render(
			createElement(KoraProvider, { app }, createElement(UserForm, { userId: undefined })),
		)
		const input = (await screen.findByLabelText('title')) as HTMLInputElement
		await act(async () => {})
		expect(input.value).toBe('')
		expect(sessionStorage.getItem('kora-draft:notes-db:user-note')).toContain('saved')
		view.rerender(
			createElement(KoraProvider, { app }, createElement(UserForm, { userId: 'alice' })),
		)
		await act(async () => {})
		expect((screen.getByLabelText('title') as HTMLInputElement).value).toBe('saved')
		expect(sessionStorage.getItem('kora-draft:notes-db:user-note')).toBeNull()
	})

	test('fail closed: a ref on a wrapper reads the control inside it; no control means not drafted unless safe', async () => {
		const app = mockApp()
		let api: ReturnType<
			typeof useFormDraft<{ secret: string; code: string; tags: string }>
		> | null = null
		function WrapperForm() {
			const draft = useFormDraft(
				'wrapped',
				{ secret: '', code: '', tags: '' },
				{ fields: ['secret', 'code', 'tags'], safe: ['tags'] },
			)
			api = draft
			const { ref, ...secretProps } = draft.bind('secret')
			// A PasswordInput component whose ref lands on its wrapper <div>.
			return createElement(
				'div',
				{ ref },
				createElement('input', { 'aria-label': 'secret', type: 'password', ...secretProps }),
			)
		}
		render(createElement(KoraProvider, { app }, createElement(WrapperForm)))
		await screen.findByLabelText('secret')
		await act(async () => {})
		fireEvent.change(screen.getByLabelText('secret'), { target: { value: 'hunter2' } })
		// `code` and `tags` are set from code: no input is bound to them.
		act(() => {
			api?.setValues({ code: '123', tags: 'a,b' })
		})
		await act(async () => {})
		const stored = sessionStorage.getItem('kora-draft:notes-db:wrapped') ?? ''
		expect(stored).not.toContain('hunter2')
		expect(stored).not.toContain('123')
		expect(JSON.parse(stored).values).toEqual({ tags: 'a,b' })
	})

	test('"show password" clicked before typing: the password never reaches sessionStorage', async () => {
		const app = mockApp()
		function Login() {
			const [shown, setShown] = useState(false)
			const draft = useFormDraft('login', { pw: '', user: '' }, { fields: ['pw', 'user'] })
			return createElement(
				'form',
				null,
				createElement('input', { 'aria-label': 'user', ...draft.bind('user') }),
				createElement('input', {
					'aria-label': 'pw',
					type: shown ? 'text' : 'password',
					...draft.bind('pw'),
				}),
				createElement('button', { type: 'button', onClick: () => setShown(true) }, 'show'),
			)
		}
		render(createElement(KoraProvider, { app }, createElement(Login)))
		await screen.findByLabelText('pw')
		await act(async () => {})
		fireEvent.click(screen.getByText('show'))
		await act(async () => {})
		expect(screen.getByLabelText('pw').getAttribute('type')).toBe('text')
		fireEvent.change(screen.getByLabelText('pw'), { target: { value: 'hunter2' } })
		fireEvent.change(screen.getByLabelText('user'), { target: { value: 'ada' } })
		await act(async () => {})
		const stored = sessionStorage.getItem('kora-draft:notes-db:login') ?? ''
		expect(stored).not.toContain('hunter2')
		expect(JSON.parse(stored).values).toEqual({ user: 'ada' })
	})

	describe('users (Codex re-audit)', () => {
		const KEY_U = 'kora-draft:notes-db:user-form'
		function UserForm({
			userId,
		}: { userId: string | null | undefined | (() => string | null | undefined) }) {
			const draft = useFormDraft(
				'user-form',
				{ title: '', body: '' },
				{ fields: ['title', 'body'], userId },
			)
			return createElement(
				'form',
				null,
				createElement('input', { 'aria-label': 'title', ...draft.bind('title') }),
				createElement('input', { 'aria-label': 'body', ...draft.bind('body') }),
			)
		}
		const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement
		const stored = () =>
			JSON.parse(sessionStorage.getItem(KEY_U) ?? 'null') as {
				user: string | null
				values: Record<string, string>
			} | null

		test("a userId getter switching accounts resets the form; the previous user's values are never stored under the new user", async () => {
			const app = mockApp()
			let current: string | null | undefined = 'alice'
			const getter = () => current
			const view = render(
				createElement(KoraProvider, { app }, createElement(UserForm, { userId: getter })),
			)
			await screen.findByLabelText('title')
			await act(async () => {})
			fireEvent.change(field('title'), { target: { value: 'alice private note' } })
			await act(async () => {})
			expect(stored()?.user).toBe('alice')
			current = 'bob'
			// The next interaction re-renders with the getter now reporting bob.
			fireEvent.change(field('body'), { target: { value: 'x' } })
			await act(async () => {})
			view.rerender(
				createElement(KoraProvider, { app }, createElement(UserForm, { userId: getter })),
			)
			await act(async () => {})
			expect(field('title').value).toBe('')
			const draft = stored()
			expect(
				draft === null || draft.user !== 'bob' || !JSON.stringify(draft).includes('alice'),
			).toBe(true)
		})

		test('fields typed while the session loads win over the stored draft; untouched fields are restored', async () => {
			const app = mockApp()
			sessionStorage.setItem(
				KEY_U,
				JSON.stringify({
					v: 1,
					user: 'alice',
					values: { title: 'saved title', body: 'saved body' },
				}),
			)
			const view = render(
				createElement(KoraProvider, { app }, createElement(UserForm, { userId: undefined })),
			)
			await screen.findByLabelText('title')
			await act(async () => {})
			fireEvent.change(field('title'), { target: { value: 'typed while loading' } })
			await act(async () => {})
			view.rerender(
				createElement(KoraProvider, { app }, createElement(UserForm, { userId: 'alice' })),
			)
			await act(async () => {})
			expect(field('title').value).toBe('typed while loading')
			expect(field('body').value).toBe('saved body')
		})

		test("alice, loading, bob: Alice's values never carry over to Bob", async () => {
			const app = mockApp()
			const view = render(
				createElement(KoraProvider, { app }, createElement(UserForm, { userId: 'alice' })),
			)
			await screen.findByLabelText('title')
			await act(async () => {})
			fireEvent.change(field('title'), { target: { value: 'alice private note' } })
			await act(async () => {})
			view.rerender(
				createElement(KoraProvider, { app }, createElement(UserForm, { userId: undefined })),
			)
			await act(async () => {})
			view.rerender(
				createElement(KoraProvider, { app }, createElement(UserForm, { userId: 'bob' })),
			)
			await act(async () => {})
			expect(field('title').value).toBe('')
			fireEvent.change(field('body'), { target: { value: 'bob' } })
			await act(async () => {})
			expect(JSON.stringify(stored())).not.toContain('alice private note')
		})

		test('while the user is unknown, a form back at its initial values or a reload never deletes the stored draft', async () => {
			const app = mockApp()
			const saved = JSON.stringify({ v: 1, user: 'alice', values: { title: 'saved title' } })
			sessionStorage.setItem(KEY_U, saved)
			render(createElement(KoraProvider, { app }, createElement(UserForm, { userId: undefined })))
			await screen.findByLabelText('title')
			await act(async () => {})
			fireEvent.change(field('title'), { target: { value: 'x' } })
			await act(async () => {})
			fireEvent.change(field('title'), { target: { value: '' } })
			await act(async () => {})
			app.events.emit({ type: 'app:before-build-reload' })
			expect(sessionStorage.getItem(KEY_U)).toBe(saved)
		})
	})

	test('sibling: a wrapper gaining data-kora-sensitive without re-rendering the form removes the stored value at once', async () => {
		const app = mockApp()
		const NoteForm = memo(function NoteForm() {
			const draft = useFormDraft('ancestor', { note: '' }, { fields: ['note'] })
			return createElement('input', { 'aria-label': 'note', ...draft.bind('note') })
		})
		function Page({ sensitive }: { sensitive: boolean }) {
			return createElement(
				'div',
				sensitive ? { 'data-kora-sensitive': '' } : {},
				createElement(NoteForm),
			)
		}
		const view = render(
			createElement(KoraProvider, { app }, createElement(Page, { sensitive: false })),
		)
		await screen.findByLabelText('note')
		await act(async () => {})
		fireEvent.change(screen.getByLabelText('note'), { target: { value: 'private' } })
		await act(async () => {})
		expect(sessionStorage.getItem('kora-draft:notes-db:ancestor')).toContain('private')
		view.rerender(createElement(KoraProvider, { app }, createElement(Page, { sensitive: true })))
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0))
		})
		expect(sessionStorage.getItem('kora-draft:notes-db:ancestor') ?? '').not.toContain('private')
	})
})
