import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { type ComponentType, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

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

beforeEach(() => {
	inserted.length = 0
	sessionStorage.clear()
})
afterEach(() => cleanup())

describe('react-basic template: new-task submit', () => {
	const field = () => screen.getByPlaceholderText('What needs to be done?') as HTMLInputElement

	test('text typed for the next task while the insert is pending is kept', async () => {
		render(createElement(App))
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
		render(createElement(App))
		fireEvent.change(field(), { target: { value: 'Only task' } })
		fireEvent.submit(field().form as HTMLFormElement)
		await act(async () => {
			resolveInsert()
		})
		expect(field().value).toBe('')
	})

	test('a second submit while the first is pending inserts once', async () => {
		render(createElement(App))
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
