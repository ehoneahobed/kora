import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { koraContextKey } from '../context'
import type { UseMutationOptions, UseMutationResult } from '../types'
import { useMutation } from './use-mutation'

type MutationHandle = UseMutationResult<unknown, unknown[]>

const providerContext = {
	store: {},
	syncEngine: null,
	app: null,
	events: null,
	subscribeSyncStatus: null,
}

function mountHandleTester(
	mutationFn: (...args: unknown[]) => Promise<unknown>,
	onReady: (handle: MutationHandle) => void,
	options?: UseMutationOptions<unknown, unknown[], unknown>,
) {
	return mount(
		defineComponent({
			setup() {
				const handle = useMutation(mutationFn, options)
				onReady(handle)
				return () => h('div')
			},
		}),
		{
			global: {
				provide: { [koraContextKey]: providerContext },
			},
		},
	)
}

function mountMutationTester(mutationFn: (...args: unknown[]) => Promise<unknown>) {
	return mount(
		defineComponent({
			setup() {
				const { mutate, mutateAsync, isLoading, error, reset } = useMutation(mutationFn)
				const resultText = ref('')
				return () =>
					h('div', null, [
						h('span', { 'data-testid': 'loading' }, String(isLoading.value)),
						h('span', { 'data-testid': 'error' }, error.value ? error.value.message : 'null'),
						h(
							'button',
							{
								type: 'button',
								'data-testid': 'mutate',
								onClick: () => mutate('arg1'),
							},
							'mutate',
						),
						h(
							'button',
							{
								type: 'button',
								'data-testid': 'mutate-async',
								onClick: async () => {
									resultText.value = String(await mutateAsync('arg1'))
								},
							},
							'mutate-async',
						),
						h(
							'button',
							{ type: 'button', 'data-testid': 'reset', onClick: () => reset() },
							'reset',
						),
						h('span', { 'data-testid': 'result' }, resultText.value),
					])
			},
		}),
		{
			global: {
				provide: { [koraContextKey]: providerContext },
			},
		},
	)
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe('useMutation', () => {
	it('mutate calls the mutation function', async () => {
		const fn = vi.fn().mockResolvedValue('ok')
		const wrapper = mountMutationTester(fn)

		await wrapper.get('[data-testid="mutate"]').trigger('click')
		await wrapper.vm.$nextTick()

		expect(fn).toHaveBeenCalledWith('arg1')
	})

	it('mutateAsync returns the result', async () => {
		const fn = vi.fn().mockResolvedValue('result-value')
		const wrapper = mountMutationTester(fn)

		await wrapper.get('[data-testid="mutate-async"]').trigger('click')
		await flushPromises()
		await wrapper.vm.$nextTick()

		expect(wrapper.get('[data-testid="result"]').text()).toBe('result-value')
	})

	it('sets error state when mutation fails', async () => {
		const fn = vi.fn().mockRejectedValue(new Error('boom'))
		const wrapper = mountMutationTester(fn)

		await wrapper.get('[data-testid="mutate"]').trigger('click')
		await wrapper.vm.$nextTick()

		expect(wrapper.get('[data-testid="error"]').text()).toBe('boom')
	})

	it('reset clears loading and error', async () => {
		const fn = vi.fn().mockRejectedValue(new Error('fail'))
		const wrapper = mountMutationTester(fn)

		await wrapper.get('[data-testid="mutate"]').trigger('click')
		await wrapper.vm.$nextTick()
		await wrapper.get('[data-testid="reset"]').trigger('click')
		await wrapper.vm.$nextTick()

		expect(wrapper.get('[data-testid="loading"]').text()).toBe('false')
		expect(wrapper.get('[data-testid="error"]').text()).toBe('null')
	})

	it('isLoading is reactive across the mutation lifecycle', async () => {
		let resolveFn: (value: string) => void = () => {}
		const fn = vi.fn(
			() =>
				new Promise<string>((resolve) => {
					resolveFn = resolve
				}),
		)
		const wrapper = mountMutationTester(fn)

		expect(wrapper.get('[data-testid="loading"]').text()).toBe('false')

		await wrapper.get('[data-testid="mutate"]').trigger('click')
		await wrapper.vm.$nextTick()
		expect(wrapper.get('[data-testid="loading"]').text()).toBe('true')

		resolveFn('done')
		await flushPromises()
		await wrapper.vm.$nextTick()
		expect(wrapper.get('[data-testid="loading"]').text()).toBe('false')
	})

	it('mutateAsync rejects so callers can await failures', async () => {
		const fn = vi.fn().mockRejectedValue(new Error('rejected'))
		let handle: MutationHandle | undefined
		mountHandleTester(fn, (h) => {
			handle = h
		})

		if (!handle) throw new Error('missing handle')
		await expect(handle.mutateAsync('x')).rejects.toThrow('rejected')
	})

	it('runs onError and onRollback callbacks when a mutation fails', async () => {
		const onMutate = vi.fn().mockReturnValue('token')
		const onRollback = vi.fn()
		const onError = vi.fn()
		const fn = vi.fn().mockRejectedValue(new Error('fail'))

		let handle: MutationHandle | undefined
		mountHandleTester(
			fn,
			(h) => {
				handle = h
			},
			{ onMutate, onRollback, onError },
		)

		if (!handle) throw new Error('missing handle')
		await expect(handle.mutateAsync('a')).rejects.toThrow('fail')

		expect(onMutate).toHaveBeenCalledWith('a')
		expect(onRollback).toHaveBeenCalledWith('token', 'a')
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'fail' }), 'a')
	})

	it('destroys the controller when the component unmounts', async () => {
		const fn = vi.fn().mockResolvedValue('ok')
		let handle: MutationHandle | undefined
		const wrapper = mountHandleTester(fn, (h) => {
			handle = h
		})

		if (!handle) throw new Error('missing handle')
		wrapper.unmount()

		// A disposed controller must reject further mutations rather than run them.
		await expect(handle.mutateAsync('x')).rejects.toThrow('destroyed')
	})

	it('does not update reactive state after unmount', async () => {
		let resolveFn: (value: string) => void = () => {}
		const fn = vi.fn(
			() =>
				new Promise<string>((resolve) => {
					resolveFn = resolve
				}),
		)
		const wrapper = mountMutationTester(fn)

		await wrapper.get('[data-testid="mutate"]').trigger('click')
		await wrapper.vm.$nextTick()

		wrapper.unmount()
		// Resolving after unmount must not throw.
		resolveFn('late')
		await flushPromises()
		expect(fn).toHaveBeenCalled()
	})
})
