<script lang="ts">
import { createRichTextBinding } from '../../src/composables/use-rich-text'

let cursors = $state('')
const binding = createRichTextBinding('notes', 'rec-1', 'body')

$effect(() => {
	return binding.subscribe((result) => {
		cursors = result.cursors.map((cursor) => cursor.userName).join(',')
	})
})
</script>

<span data-testid="cursors">{cursors}</span>
