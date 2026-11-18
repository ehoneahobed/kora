<script lang="ts">
import KoraProvider from '../../src/components/KoraProvider.svelte'
import type { KoraAppLike } from '../../src/types'
import RichTextCursorsInner from './RichTextCursorsInner.svelte'

const { app }: { app: KoraAppLike } = $props()
</script>

<KoraProvider {app}>
	<RichTextCursorsInner />
</KoraProvider>
