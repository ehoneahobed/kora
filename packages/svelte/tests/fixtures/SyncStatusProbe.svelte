<script lang="ts">
	import { createSyncStatusStore } from '../../src/composables/use-sync-status'

	const status = createSyncStatusStore()
</script>

<span data-testid="status">{$status.status}</span>
