import { KoraProvider } from '@korajs/vue'
import { createApp as createKoraApp } from 'korajs'
import { createApp, h } from 'vue'
import App from './App.vue'
import schema from './schema'
import './index.css'
import koraWorkerUrl from './kora-worker.ts?worker&url'

const kora = createKoraApp({
	schema,
	store: {
		workerUrl: koraWorkerUrl,
	},
	devtools: true,
})

createApp({
	render: () =>
		h(KoraProvider, { app: kora, fallback: h('div', 'Loading...') }, { default: () => h(App) }),
}).mount('#app')
