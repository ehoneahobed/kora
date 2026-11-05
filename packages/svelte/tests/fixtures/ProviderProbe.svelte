<script lang="ts">
import { getKoraContext } from '../../src/context'
import type { KoraContextValue } from '../../src/types'

const { report }: { report: (context: KoraContextValue) => void } = $props()
report(getKoraContext())
</script>

<p>shell</p>
