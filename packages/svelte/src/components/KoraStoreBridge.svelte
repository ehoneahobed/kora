<script lang="ts">
import { QueryStoreCache } from '@korajs/store'
import { setKoraAppContext, setKoraContext } from '../context'
import type { KoraAppLike, KoraContextValue } from '../types'

interface Props {
	store: KoraContextValue['store']
	syncEngine: KoraContextValue['syncEngine']
	app?: KoraContextValue['app']
	events?: KoraContextValue['events']
	subscribeSyncStatus?: KoraContextValue['subscribeSyncStatus']
	children?: import('svelte').Snippet
}

const {
	store,
	syncEngine,
	app = null,
	events = null,
	subscribeSyncStatus = null,
	children,
}: Props = $props()

const fallbackQueryStoreCache = new QueryStoreCache()
const queryStoreCache =
	app && typeof app.getQueryStoreCache === 'function'
		? app.getQueryStoreCache()
		: fallbackQueryStoreCache

setKoraContext({
	store,
	syncEngine,
	app,
	events,
	subscribeSyncStatus,
	queryStoreCache,
})
if (app) {
	setKoraAppContext(app)
}
</script>

{#if children}
	{@render children()}
{/if}
