<script lang="ts">
import KoraProvider from '../../src/components/KoraProvider.svelte'
import type { KoraAppLike } from '../../src/types'
import RichTextBindingInner from './RichTextBindingInner.svelte'

const { app }: { app: KoraAppLike } = $props()
</script>

<KoraProvider {app}>
	<RichTextBindingInner />
</KoraProvider>
