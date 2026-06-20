# @korajs/vue

Experimental Vue 3 bindings stub for [Kora.js](https://github.com/korajs/kora). Production React apps should use `@korajs/react` until reactive query composables land here.

## Usage

```typescript
import { createApp as createKoraApp } from 'korajs'
import { createApp as createVueApp } from 'vue'
import { installKora } from '@korajs/vue'
import schema from './schema'

const kora = createKoraApp({ schema, store: { workerUrl: '/sqlite-wasm-worker.js' } })
const vue = createVueApp(App)
installKora(vue, kora)
await kora.ready
vue.mount('#app')
```

In components, use `useKoraApp()` then `app.todos.where({}).exec()` or wire your own `watch` on `app.events`.
