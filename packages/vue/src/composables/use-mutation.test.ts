import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { koraContextKey } from '../context'
import { useMutation } from './use-mutation'

const providerContext = {
	store: {},
	syncEngine: null,
	app: null,
	events: null,
	subscribeSyncStatus: null,
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
})
