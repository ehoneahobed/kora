import { cleanup, render } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MutationLifecycle from '../../tests/fixtures/MutationLifecycle.svelte'
import type { UseMutationResult } from '../types'
import { createMutation } from './use-mutation'

afterEach(() => {
	cleanup()
	vi.restoreAllMocks()
})

describe('createMutation', () => {
	it('mutate calls the mutation function', async () => {
		const fn = vi.fn().mockResolvedValue('ok')
		const { mutate } = createMutation(fn)

		mutate('arg1')
		await vi.waitFor(() => {
			expect(fn).toHaveBeenCalledWith('arg1')
		})
	})

	it('mutateAsync returns the result', async () => {
		const fn = vi.fn().mockResolvedValue('result-value')
		const { mutateAsync } = createMutation(fn)

		await expect(mutateAsync('arg1')).resolves.toBe('result-value')
	})

	it('sets error state when mutation fails', async () => {
		const fn = vi.fn().mockRejectedValue(new Error('boom'))
		const mutation = createMutation(fn)

		await expect(mutation.mutateAsync('arg1')).rejects.toThrow('boom')
		expect(mutation.error?.message).toBe('boom')
	})

	it('reset clears loading and error', async () => {
		const fn = vi.fn().mockRejectedValue(new Error('fail'))
		const mutation = createMutation(fn)

		mutation.mutate('arg1')
		await vi.waitFor(() => {
			expect(mutation.error?.message).toBe('fail')
		})

		mutation.reset()
		expect(mutation.isLoading).toBe(false)
		expect(mutation.error).toBeNull()
	})

	it('mutateAsync rejects so callers can await failures', async () => {
		const fn = vi.fn().mockRejectedValue(new Error('rejected'))
		const { mutateAsync } = createMutation(fn)

		await expect(mutateAsync('x')).rejects.toThrow('rejected')
	})

	it('fire-and-forget mutate surfaces the error without throwing', async () => {
		const fn = vi.fn().mockRejectedValue(new Error('silent'))
		const mutation = createMutation(fn)

		// Must not throw / cause an unhandled rejection.
		mutation.mutate('x')

		await vi.waitFor(() => {
			expect(mutation.error?.message).toBe('silent')
		})
	})

	it('runs onError and onRollback lifecycle callbacks when a mutation fails', async () => {
		const onMutate = vi.fn().mockReturnValue('token')
		const onRollback = vi.fn()
		const onError = vi.fn()
		const fn = vi.fn().mockRejectedValue(new Error('fail'))

		const mutation = createMutation(fn, { onMutate, onRollback, onError })
		await expect(mutation.mutateAsync('a')).rejects.toThrow('fail')

		expect(onMutate).toHaveBeenCalledWith('a')
		expect(onRollback).toHaveBeenCalledWith('token', 'a')
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'fail' }), 'a')
	})

	it('notifies subscribeLoading/subscribeError listeners across a mutation', async () => {
		let resolveFn: (value: string) => void = () => {}
		const fn = vi.fn(
			() =>
				new Promise<string>((resolve) => {
					resolveFn = resolve
				}),
		)
		const mutation = createMutation(fn)

		const loadingStates: boolean[] = []
		mutation.subscribeLoading((value) => loadingStates.push(value))
		expect(loadingStates).toEqual([false])

		mutation.mutate()
		expect(loadingStates.at(-1)).toBe(true)

		resolveFn('done')
		await vi.waitFor(() => {
			expect(loadingStates.at(-1)).toBe(false)
		})
	})
})

describe('createMutation lifecycle', () => {
	it('destroys the controller when the owning component unmounts', async () => {
		const fn = vi.fn().mockResolvedValue('ok')
		let handle: UseMutationResult<unknown, unknown[]> | undefined
		const { unmount } = render(MutationLifecycle, {
			props: {
				mutationFn: fn,
				onready: (mutation: UseMutationResult<unknown, unknown[]>) => {
					handle = mutation
				},
			},
		})

		if (!handle) {
			throw new Error('Expected mutation handle to be captured')
		}

		unmount()

		// After unmount the controller must be disposed: further mutations reject.
		await expect(handle.mutateAsync('x')).rejects.toThrow('destroyed')
	})

	it('reactively reflects error state in a mounted component', async () => {
		const fn = vi.fn().mockRejectedValue(new Error('boom'))
		const { getByTestId } = render(MutationLifecycle, {
			props: { mutationFn: fn, onready: () => {} },
		})

		await userEvent.click(getByTestId('mutate'))

		await vi.waitFor(() => {
			expect(getByTestId('error').textContent).toBe('boom')
		})
	})
})
