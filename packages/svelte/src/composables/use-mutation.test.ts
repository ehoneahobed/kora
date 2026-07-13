import { describe, expect, it, vi } from 'vitest'
import { createMutation } from './use-mutation'

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
})
