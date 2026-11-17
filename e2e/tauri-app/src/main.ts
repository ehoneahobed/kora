// What the tauri-react template does: the app imports @korajs/tauri and lets createApp
// detect the storage. Inside Tauri (window.__TAURI_INTERNALS__) that is the native SQLite adapter.
import '@korajs/tauri'
import { createApp, defineSchema, t } from 'korajs'

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})

const status = document.getElementById('status') as HTMLElement
const app = createApp({ schema })
app.ready.then(
	() => {
		status.textContent = 'ready'
	},
	(error: unknown) => {
		status.textContent = `failed: ${error instanceof Error ? error.message : String(error)}`
	},
)
