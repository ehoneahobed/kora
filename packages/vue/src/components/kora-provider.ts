import { QueryStoreCache } from '@korajs/store'
import type { Store } from '@korajs/store'
import type { SyncEngine } from '@korajs/sync'
import {
	type PropType,
	type VNode,
	defineComponent,
	h,
	onScopeDispose,
	provide,
	ref,
	shallowRef,
	watch,
} from 'vue'
import { koraContextKey, koraAppInjectionKey } from '../context'
import type { KoraAppLike, KoraContextValue } from '../types'
import { resolveQueryStoreCache } from '../resolve-query-store-cache'

export const KoraProvider = defineComponent({
	name: 'KoraProvider',
	props: {
		app: {
			type: Object as PropType<KoraAppLike>,
			default: undefined,
		},
		store: {
			type: Object as PropType<Store>,
			default: undefined,
		},
		syncEngine: {
			type: Object as PropType<SyncEngine | null>,
			default: undefined,
		},
		fallback: {
			type: [Object, String] as PropType<VNode | string | null>,
			default: null,
		},
	},
	setup(props, { slots }) {
		const resolvedStore = ref<Store | null>(null)
		const resolvedSync = ref<SyncEngine | null>(null)
		const ready = ref(!props.app && Boolean(props.store))
		const initError = ref<Error | null>(null)
		const fallbackQueryStoreCache = new QueryStoreCache()
		const contextRef = shallowRef<KoraContextValue | null>(null)

		provide(koraContextKey, contextRef)
		if (props.app) {
			provide(koraAppInjectionKey, props.app)
		}

		watch(
			() => props.app,
			(app, _previous, onCleanup) => {
				if (!app) {
					if (props.store) {
						resolvedStore.value = props.store as Store
						resolvedSync.value = (props.syncEngine ?? null) as SyncEngine | null
						ready.value = true
					}
					return
				}

				ready.value = false
				initError.value = null
				let cancelled = false

				app.ready
					.then(() => {
						if (cancelled) return
						resolvedStore.value = app.getStore() as Store
						resolvedSync.value = app.getSyncEngine() as SyncEngine | null
						ready.value = true
					})
					.catch((error: unknown) => {
						if (cancelled) return
						const err = error instanceof Error ? error : new Error(String(error))
						console.error('[Kora] Initialization failed:', err)
						initError.value = err
					})

				onCleanup(() => {
					cancelled = true
				})
			},
			{ immediate: true },
		)

		watch(
			() => props.store,
			(store) => {
				if (store && !props.app) {
					resolvedStore.value = store as Store
					resolvedSync.value = (props.syncEngine ?? null) as SyncEngine | null
					ready.value = true
				}
			},
			{ immediate: true },
		)

		watch(
			() => [resolvedStore.value, resolvedSync.value, props.app] as const,
			([store, syncEngine, app]) => {
				if (!store) {
					contextRef.value = null
					return
				}

				contextRef.value = {
					store: store as Store,
					syncEngine: (syncEngine ?? null) as SyncEngine | null,
					app: app ?? null,
					events: app?.events ?? null,
					subscribeSyncStatus: app?.sync?.subscribeStatus ?? null,
					queryStoreCache: resolveQueryStoreCache(app, fallbackQueryStoreCache),
				}
			},
			{ immediate: true },
		)

		onScopeDispose(() => {
			if (!props.app) {
				fallbackQueryStoreCache.clear()
			}
		})

		return () => {
			if (initError.value) {
				return h(
					'div',
					{ style: { color: 'red', padding: '1rem', fontFamily: 'monospace' } },
					[h('strong', null, 'Kora initialization error: '), initError.value.message],
				)
			}

			if (!ready.value) {
				return props.fallback ?? null
			}

			if (!resolvedStore.value) {
				throw new Error(
					'KoraProvider requires either an "app" or "store" prop. Pass createApp() or a Store instance.',
				)
			}

			return slots.default?.()
		}
	},
})
