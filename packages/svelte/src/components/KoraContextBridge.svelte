<script lang="ts">
import { createPendingStore } from '@korajs/core/bindings'
import { QueryStoreCache } from '@korajs/store/lite'
import { setKoraAppContext, setKoraContext } from '../context'
import type { KoraAppLike, KoraContextValue } from '../types'

interface Props {
	app: KoraAppLike
	/** Whether the store is already open when this bridge mounts. */
	opened?: boolean
	children?: import('svelte').Snippet
}

// `opened` and `app` are read once: the bridge is mounted for one app, and the context it
// sets is live (getters), so it follows the swap from the pending store to the real one.
const { app, opened = true, children }: Props = $props()

const fallbackQueryStoreCache = new QueryStoreCache()
const queryStoreCache =
	typeof app.getQueryStoreCache === 'function' ? app.getQueryStoreCache() : fallbackQueryStoreCache

let store: KoraContextValue['store'] = opened
	? app.getStore()
	: createPendingStore<KoraContextValue['store']>(app.collections)
let syncEngine: KoraContextValue['syncEngine'] = opened ? app.getSyncEngine() : null

if (!opened) {
	// Registered before any child can register its own `then`, so a child told that the
	// store opened (it waits on app.ready too) reads the real store.
	app.ready.then(
		() => {
			store = app.getStore()
			syncEngine = app.getSyncEngine()
		},
		() => {},
	)
}

setKoraContext({
	get store() {
		return store
	},
	get syncEngine() {
		return syncEngine
	},
	app,
	events: app.events ?? null,
	subscribeSyncStatus: app.sync?.subscribeStatus ?? null,
	queryStoreCache,
})
setKoraAppContext(app)
</script>

{#if children}
	{@render children()}
{/if}
