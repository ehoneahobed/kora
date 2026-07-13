<script lang="ts">
	import type { OrgClient } from '../client/org-client'
	import { onDestroy } from 'svelte'
	import { destroyOrgProvider, initOrgProvider } from './org-context'

	interface Props {
		client: OrgClient
		children?: import('svelte').Snippet
	}

	let { client, children }: Props = $props()

	const orgContext = initOrgProvider(client)

	onDestroy(() => {
		destroyOrgProvider(orgContext)
	})
</script>

{#if children}
	{@render children()}
{/if}
