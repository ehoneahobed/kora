<script lang="ts">
import { QueryStoreCache } from '@korajs/store'
import { setKoraAppContext, setKoraContext } from '../context'
import type { KoraAppLike } from '../types'

interface Props {
	app: KoraAppLike
	children?: import('svelte').Snippet
}

const { app, children }: Props = $props()

const fallbackQueryStoreCache = new QueryStoreCache()
const queryStoreCache =
	typeof app.getQueryStoreCache === 'function' ? app.getQueryStoreCache() : fallbackQueryStoreCache

setKoraContext({
	store: app.getStore(),
	syncEngine: app.getSyncEngine(),
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
