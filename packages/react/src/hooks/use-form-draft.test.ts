import { defineSchema, t } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import type { Store } from '@korajs/store'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
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
})
