import { createApp as createKoraApp } from 'korajs'
import { mount } from 'svelte'
import Root from './Root.svelte'
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

mount(Root, { target: document.getElementById('app')!, props: { kora } })
