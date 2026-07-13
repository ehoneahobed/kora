<script lang="ts">
	import { createRichTextBinding } from '../../src/composables/use-rich-text'

	let value = $state('loading')
	const binding = createRichTextBinding('notes', 'rec-1', 'body')

	$effect(() => {
		return binding.subscribe((result) => {
			value = result.ready ? result.text.toString() : 'loading'
		})
	})
</script>

<span data-testid="value">{value}</span>
