import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { createApp, defineComponent, h } from 'vue'
import { installKora, useKoraApp } from './index'
import type { KoraAppLike } from './types'

describe('installKora / useKoraApp', () => {
	it('provides the app so useKoraApp can retrieve it', () => {
		const app = { ready: Promise.resolve() } as unknown as KoraAppLike
		let captured: KoraAppLike | null = null

		const Child = defineComponent({
			setup() {
				captured = useKoraApp()
				return () => h('div')
			},
		})

		const Root = defineComponent({ setup: () => () => h(Child) })
		const vueApp = createApp(Root)
		installKora(vueApp, app)
		const el = document.createElement('div')
		vueApp.mount(el)

		expect(captured).toBe(app)
		vueApp.unmount()
	})

	it('throws a KORA_NOT_PROVIDED error when no app was installed', () => {
		let error: unknown = null
		const Comp = defineComponent({
			setup() {
				try {
					useKoraApp()
				} catch (err) {
					error = err
				}
				return () => h('div')
			},
		})

		mount(Comp)
		expect((error as Error).message).toContain('useKoraApp() requires installKora')
	})
})
