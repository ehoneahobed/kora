import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { StrictMode, createElement } from 'react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Count controller subscriptions by wrapping the real controller factory.
const subscribeCalls = { count: 0 }
vi.mock('@korajs/core/bindings', async (importOriginal) => {
	const mod = await importOriginal<typeof import('@korajs/core/bindings')>()
	return {
		...mod,
		createMutationController: (...args: Parameters<typeof mod.createMutationController>) => {
			const c = mod.createMutationController(...args)
			const sub = c.subscribe
			return {
				...c,
				subscribe: (l: () => void) => {
					subscribeCalls.count += 1
					return sub(l)
				},
			}
		},
	}
})

import { useMutation } from '../../src/hooks/use-mutation'

afterEach(() => {
	cleanup()
	subscribeCalls.count = 0
})

describe('DX-5 useMutation referential stability', () => {
	it('mutate/mutateAsync/reset keep identity across re-renders', () => {
		const fn = vi.fn().mockResolvedValue('ok')
		const { result, rerender } = renderHook(() => useMutation(fn))
		const first = result.current
		rerender()
		rerender()
		expect(result.current.mutate).toBe(first.mutate)
		expect(result.current.mutateAsync).toBe(first.mutateAsync)
		expect(result.current.reset).toBe(first.reset)
	})

	it('does not resubscribe to the controller on every render', () => {
		const fn = vi.fn().mockResolvedValue('ok')
		const { rerender } = renderHook(() => useMutation(fn))
		const afterMount = subscribeCalls.count
		for (let i = 0; i < 5; i++) rerender()
		expect(subscribeCalls.count).toBe(afterMount)
	})

	it('works under React.StrictMode (isLoading toggles, result resolves)', async () => {
		let resolve: (v: string) => void = () => {}
		const fn = vi.fn(() => new Promise<string>((r) => (resolve = r)))
		const wrapper = ({ children }: { children: ReactNode }) =>
			createElement(StrictMode, null, children)
		const { result } = renderHook(() => useMutation(fn), { wrapper })
		let p: Promise<string> = Promise.resolve('')
		act(() => {
			p = result.current.mutateAsync()
		})
		await waitFor(() => expect(result.current.isLoading).toBe(true))
		await act(async () => {
			resolve('done')
			await p
		})
		expect(result.current.isLoading).toBe(false)
		expect(await p).toBe('done')
	})
})
