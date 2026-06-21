# @korajs/svelte

Experimental Svelte bindings stub for [Kora.js](https://github.com/korajs/kora). Use `@korajs/react` for full reactive query hooks today.

## Usage

```svelte
<script lang="ts">
  import { createApp } from 'korajs'
  import { setKoraAppContext, getKoraApp } from '@korajs/svelte'
  import schema from './schema'

  const kora = createApp({ schema, store: { workerUrl: '/sqlite-wasm-worker.js' } })
  setKoraAppContext(kora)
  await kora.ready
</script>
```

Child components call `getKoraApp()` and use collection accessors or subscribe to `app.events`.
