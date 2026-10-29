import { OFFLINE_STATUS_UNKNOWN } from '@korajs/core/bindings'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { type ComponentType, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { KoraProvider } from '../../src/context/kora-context'
import type { KoraProviderProps } from '../../src/types'

/**
 * The CLI's react-basic template, rendered for real (its `useTodos` module mocked): the
 * new-task form's submit (Codex review of #72).
 */

const inserted: string[] = []
let resolveInsert: () => void = () => {}

vi.mock('../../../cli/templates/react-basic/src/modules/todos/useTodos', () => ({
	useTodos: () => ({
		allTodos: [],
		activeTodos: [],
		completedTodos: [],
		addTodo: {
			mutateAsync: (input: { title: string }) => {
				inserted.push(input.title)
				return new Promise<void>((resolve) => {
					resolveInsert = resolve
				})
			},
			mutate: () => {},
			isLoading: false,
		},
		toggleTodo: { mutate: () => {} },
		deleteTodo: { mutate: () => {} },
	}),
}))

// A computed specifier keeps this package's `tsc` out of the template: the template is
// typechecked against its own dependencies by the CLI's template checks, not from here.
const TEMPLATE_APP = '../../../cli/templates/react-basic/src/App'
const { App } = (await import(/* @vite-ignore */ TEMPLATE_APP)) as { App: ComponentType }

// The template renders <OfflineBadge />, which reads `app.offline` through the provider: a
// fake app with the same surface (status/subscribe) as the real one.
const fakeApp = {
	ready: Promise.resolve(),
	getStore: () => ({}),
	getSyncEngine: () => null,
	offline: { status: () => OFFLINE_STATUS_UNKNOWN, subscribe: () => () => {} },
} as unknown as NonNullable<KoraProviderProps['app']>
// The provider renders its children once `app.ready` has resolved.
const renderApp = async () => {
	await act(async () => {
		render(createElement(KoraProvider, { app: fakeApp }, createElement(App)))
	})
}

beforeEach(() => {
	inserted.length = 0
	sessionStorage.clear()
})
afterEach(() => cleanup())

describe('react-basic template: new-task submit', () => {
	const field = () => screen.getByPlaceholderText('What needs to be done?') as HTMLInputElement

	test('text typed for the next task while the insert is pending is kept', async () => {
		await renderApp()
		fireEvent.change(field(), { target: { value: 'First task' } })
		fireEvent.submit(field().form as HTMLFormElement)
		// The write is still pending: the user starts the next task.
		fireEvent.change(field(), { target: { value: 'Second task' } })
		await act(async () => {
			resolveInsert()
		})
		expect(inserted).toEqual(['First task'])
		expect(field().value).toBe('Second task')
	})

	test('the field is cleared once the write is stored when it still holds the submitted text', async () => {
		await renderApp()
		fireEvent.change(field(), { target: { value: 'Only task' } })
		fireEvent.submit(field().form as HTMLFormElement)
		await act(async () => {
			resolveInsert()
		})
		expect(field().value).toBe('')
	})

	test('a second submit while the first is pending inserts once', async () => {
		await renderApp()
		fireEvent.change(field(), { target: { value: 'Task' } })
		const form = field().form as HTMLFormElement
		fireEvent.submit(form)
		fireEvent.submit(form)
		await act(async () => {
			resolveInsert()
		})
		expect(inserted).toEqual(['Task'])
	})
})
