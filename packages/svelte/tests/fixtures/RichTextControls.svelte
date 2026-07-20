<script lang="ts">
import { createRichTextBinding } from '../../src/composables/use-rich-text'

let ready = $state(false)
let canUndo = $state(false)
let value = $state('')

const binding = createRichTextBinding('notes', 'rec-1', 'body')

$effect(() =>
	binding.subscribe((result) => {
		ready = result.ready
		canUndo = result.canUndo
		value = result.text.toString()
	}),
)
</script>

<span data-testid="ready">{ready ? 'yes' : 'no'}</span>
<span data-testid="canUndo">{canUndo ? 'u1' : 'u0'}</span>
<span data-testid="value">{value}</span>
<button type="button" data-testid="edit" onclick={() => binding.text.insert(0, 'Draft')}>edit</button>
<button type="button" data-testid="undo" onclick={() => binding.undo()}>undo</button>
<button type="button" data-testid="redo" onclick={() => binding.redo()}>redo</button>
