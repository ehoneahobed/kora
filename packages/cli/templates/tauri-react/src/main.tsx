// Native SQLite storage: importing @korajs/tauri puts its adapter in the bundle, and createApp
// uses it when the app runs inside Tauri.
import '@korajs/tauri'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppShell } from './AppShell'

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<AppShell />
	</StrictMode>,
)
