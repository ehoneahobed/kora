import type { OfflineKeepOptions, OfflineKeepQuery } from '@korajs/core/bindings'
import type { Store } from '@korajs/store'
import { act, cleanup, render, screen } from '@testing-library/react'
import { StrictMode, createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KoraProvider } from '../context/kora-context'
import type { KoraAppLike } from '../types'
import { useOfflineKeep } from './use-offline-keep'

afterEach(() => {
	cleanup()
	vi.restoreAllMocks()
})

const query = (where: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
	({ getDescriptor: () => ({ collection: 'lessons', where, ...extra }) }) as OfflineKeepQuery

function fakeApp(options: { refuse?: Error } = {}) {
	const holds: Array<{ where: unknown; files: boolean | undefined; released: boolean }> = []
	const app = {
		ready: Promise.resolve(),
		getStore: () => ({}) as Store,
		getSyncEngine: () => null,
		offline: {
			status: () => ({}),
			subscribe: () => () => {},
			hold: async (q: OfflineKeepQuery, opts?: OfflineKeepOptions) => {
				if (options.refuse) throw options.refuse
				const hold = { where: q.getDescriptor().where, files: opts?.files, released: false }
				holds.push(hold)
				return async () => {
					hold.released = true
				}
			},
		},
	} as unknown as KoraAppLike
	return { app, holds, active: () => holds.filter((hold) => !hold.released) }
}

function Probe(props: { where: Record<string, unknown>; files?: boolean; extra?: Record<string, unknown> }) {
	const result = useOfflineKeep(query(props.where, props.extra), { files: props.files })
	return createElement(
		'span',
		{ 'data-testid': 'state' },
		`${result.held ? 'held' : 'not-held'}:${result.error?.message ?? ''}`,
	)
}

async function settle(): Promise<void> {
	await act(async () => {
		for (let i = 0; i < 5; i++) await Promise.resolve()
	})
}

describe('useOfflineKeep', () => {
	it('holds the pin while mounted and releases it on unmount', async () => {
		const fake = fakeApp()
		const view = render(
			createElement(
				KoraProvider,
				{ app: fake.app },
				createElement(Probe, { where: { courseId: 'c1' }, files: true }),
			),
		)
		await settle()
		expect(screen.getByTestId('state').textContent).toBe('held:')
		expect(fake.active()).toEqual([{ where: { courseId: 'c1' }, files: true, released: false }])
		view.unmount()
		await settle()
		expect(fake.active()).toEqual([])
	})

	it('StrictMode double mount leaves exactly one hold', async () => {
		const fake = fakeApp()
		const view = render(
			createElement(
				StrictMode,
				null,
				createElement(
					KoraProvider,
					{ app: fake.app },
					createElement(Probe, { where: { courseId: 'c1' } }),
				),
			),
		)
		await settle()
		expect(fake.holds.length).toBeGreaterThanOrEqual(2)
		expect(fake.active()).toHaveLength(1)
		view.unmount()
		await settle()
		expect(fake.active()).toEqual([])
	})

	it('a new query object with the same pin does not hold again', async () => {
		const fake = fakeApp()
		const tree = (where: Record<string, unknown>) =>
			createElement(KoraProvider, { app: fake.app }, createElement(Probe, { where }))
		const view = render(tree({ courseId: 'c1', b: { $gt: 1, $lt: 3 } }))
		await settle()
		view.rerender(tree({ b: { $lt: 3, $gt: 1 }, courseId: 'c1' }))
		await settle()
		expect(fake.holds).toHaveLength(1)
	})

	it('a different query releases the old pin and holds the new one', async () => {
		const fake = fakeApp()
		const tree = (courseId: string) =>
			createElement(KoraProvider, { app: fake.app }, createElement(Probe, { where: { courseId } }))
		const view = render(tree('c1'))
		await settle()
		view.rerender(tree('c2'))
		await settle()
		expect(fake.active().map((hold) => hold.where)).toEqual([{ courseId: 'c2' }])
		expect(fake.holds).toHaveLength(2)
	})

	it('two components on one query are two holds', async () => {
		const fake = fakeApp()
		render(
			createElement(
				KoraProvider,
				{ app: fake.app },
				createElement(Probe, { where: { courseId: 'c1' } }),
				createElement(Probe, { where: { courseId: 'c1' } }),
			),
		)
		await settle()
		expect(fake.active()).toHaveLength(2)
	})

	it('an unsupported query reports its error and holds nothing', async () => {
		const fake = fakeApp()
		render(
			createElement(
				KoraProvider,
				{ app: fake.app },
				createElement(Probe, { where: {}, extra: { limit: 5 } }),
			),
		)
		await settle()
		expect(screen.getByTestId('state').textContent).toMatch(/^not-held:.*limit/)
		expect(fake.holds).toEqual([])
	})

	it('a refused hold (the pin limit) is reported', async () => {
		const fake = fakeApp({ refuse: new Error('64 pins') })
		render(
			createElement(
				KoraProvider,
				{ app: fake.app },
				createElement(Probe, { where: { courseId: 'c1' } }),
			),
		)
		await settle()
		expect(screen.getByTestId('state').textContent).toBe('not-held:64 pins')
	})

	it('does nothing with an app that has no offline API', async () => {
		const app = {
			ready: Promise.resolve(),
			getStore: () => ({}) as Store,
			getSyncEngine: () => null,
		} as unknown as KoraAppLike
		render(createElement(KoraProvider, { app }, createElement(Probe, { where: {} })))
		await settle()
		expect(screen.getByTestId('state').textContent).toBe('not-held:')
	})

	it('server render holds nothing', () => {
		const html = renderToString(
			createElement(
				KoraProvider,
				{ store: {} as Store, app: undefined },
				createElement(Probe, { where: {} }),
			),
		)
		expect(html).toContain('not-held:')
	})
})
