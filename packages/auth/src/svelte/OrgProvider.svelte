<script lang="ts">
import { onDestroy } from 'svelte'
import type { OrgClient } from '../client/org-client'
import { destroyOrgProvider, initOrgProvider } from './org-context'

interface Props {
	client: OrgClient
	children?: import('svelte').Snippet
}

const { client, children }: Props = $props()

const orgContext = initOrgProvider(client)

onDestroy(() => {
	destroyOrgProvider(orgContext)
})
</script>

{#if children}
	{@render children()}
{/if}
