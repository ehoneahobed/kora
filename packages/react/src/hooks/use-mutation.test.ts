import { act, cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMutation } from './use-mutation'

afterEach(() => {
	cleanup()
})

function MutationTester({
	mutationFn,
}: {
	mutationFn: (...args: unknown[]) => Promise<unknown>
}): ReturnType<typeof createElement> {
	const { mutate, mutateAsync, isLoading, error, reset } = useMutation(mutationFn)

	return createElement(
		'div',
		null,
		createElement('span', { 'data-testid': 'loading' }, String(isLoading)),
		createElement('span', { 'data-testid': 'error' }, error ? error.message : 'null'),
		createElement('button', {
			type: 'button',
			'data-testid': 'mutate',
			onClick: () => mutate('arg1'),
		}),
		createElement('button', {
			type: 'button',
			'data-testid': 'mutate-async',
			onClick: async () => {
				try {
					const result = await mutateAsync('arg1')
					// Store result in DOM for assertion
					const el = document.getElementById('result')
					if (el) el.textContent = String(result)
				} catch {
					// error is in state
				}
			},
		}),
		createElement('button', { type: 'button', 'data-testid': 'reset', onClick: () => reset() }),
		createElement('span', { id: 'result', 'data-testid': 'result' }),
	)
}

describe('useMutation', () => {
	it('mutate calls the mutation function', async () => {
		const fn = vi.fn().mockResolvedValue('ok')
		render(createElement(MutationTester, { mutationFn: fn }))

		await act(async () => {
			screen.getByTestId('mutate').click()
		})

		expect(fn).toHaveBeenCalledWith('arg1')
	})

	it('mutateAsync returns the result', async () => {
		const fn = vi.fn().mockResolvedValue('result-value')
		render(createElement(MutationTester, { mutationFn: fn }))

		await act(async () => {
			screen.getByTestId('mutate-async').click()
		})

		expect(screen.getByTestId('result').textContent).toBe('result-value')
	})

	it('isLoading updates during mutation', async () => {
		let resolveFn: (value: string) => void = () => {}
		const fn = vi.fn().mockImplementation(
			() =>
				new Promise<string>((resolve) => {
					resolveFn = resolve
				}),
		)

		render(createElement(MutationTester, { mutationFn: fn }))

		expect(screen.getByTestId('loading').textContent).toBe('false')

		// Start mutation
		act(() => {
			screen.getByTestId('mutate').click()
		})

		expect(screen.getByTestId('loading').textContent).toBe('true')

		// Resolve mutation
		await act(async () => {
			resolveFn('done')
		})

		expect(screen.getByTestId('loading').textContent).toBe('false')
	})

	it('captures error in state', async () => {
		const fn = vi.fn().mockRejectedValue(new Error('mutation failed'))
		render(createElement(MutationTester, { mutationFn: fn }))

		await act(async () => {
			screen.getByTestId('mutate').click()
		})

		expect(screen.getByTestId('error').textContent).toBe('mutation failed')
	})

	it('reset clears error and loading state', async () => {
		const fn = vi.fn().mockRejectedValue(new Error('mutation failed'))
		render(createElement(MutationTester, { mutationFn: fn }))

		await act(async () => {
			screen.getByTestId('mutate').click()
		})

		expect(screen.getByTestId('error').textContent).toBe('mutation failed')

		act(() => {
			screen.getByTestId('reset').click()
		})

		expect(screen.getByTestId('error').textContent).toBe('null')
		expect(screen.getByTestId('loading').textContent).toBe('false')
	})

	it('fire-and-forget mutate does not throw on error', async () => {
		const fn = vi.fn().mockRejectedValue(new Error('silent error'))
		render(createElement(MutationTester, { mutationFn: fn }))

		// This should not throw or cause unhandled rejection
		await act(async () => {
			screen.getByTestId('mutate').click()
		})

		expect(screen.getByTestId('error').textContent).toBe('silent error')
	})

	it('does not update state after unmount', async () => {
		let resolveFn: (value: string) => void = () => {}
		const fn = vi.fn().mockImplementation(
			() =>
				new Promise<string>((resolve) => {
					resolveFn = resolve
				}),
		)

		const { unmount } = render(createElement(MutationTester, { mutationFn: fn }))

		act(() => {
			screen.getByTestId('mutate').click()
		})

		// Unmount before resolving
		unmount()

		// Resolve after unmount — should not cause error
		await act(async () => {
			resolveFn('late-result')
		})

		// If we got here without an error, the test passes
		expect(fn).toHaveBeenCalled()
	})
})
