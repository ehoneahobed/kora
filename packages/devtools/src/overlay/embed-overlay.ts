import type { Instrumenter } from '../instrumenter/instrumenter'
import { renderDevtoolsPanel } from '../ui/panel'
import { KORA_DEVTOOLS_STYLES } from '../ui/panel-styles'

const OVERLAY_HOST_ID = 'kora-devtools-overlay-host'

/**
 * Mount an in-page DevTools panel toggled with Ctrl+Shift+K (Cmd+Shift+K on macOS).
 *
 * @param instrumenter - Active instrumenter from createApp({ devtools: true })
 * @returns Teardown function (also called when overlay is destroyed)
 */
export function mountKoraDevtoolsOverlay(instrumenter: Instrumenter): () => void {
	if (typeof document === 'undefined') {
		return () => {}
	}

	const existing = document.getElementById(OVERLAY_HOST_ID)
	if (existing) {
		existing.remove()
	}

	const host = document.createElement('div')
	host.id = OVERLAY_HOST_ID
	host.style.cssText =
		'position:fixed;inset:auto 12px 12px 12px;height:42vh;z-index:2147483646;display:none;'

	const shadow = host.attachShadow({ mode: 'open' })

	const style = document.createElement('style')
	style.textContent = KORA_DEVTOOLS_STYLES
	shadow.appendChild(style)

	const panelRoot = document.createElement('div')
	panelRoot.id = 'kora-devtools-root'
	panelRoot.style.height = '100%'
	shadow.appendChild(panelRoot)

	const hint = document.createElement('div')
	hint.textContent = 'Kora DevTools (Ctrl+Shift+K)'
	hint.style.cssText =
		'position:fixed;bottom:8px;right:12px;z-index:2147483645;font:11px sans-serif;color:#6c7086;background:#1e1e2e;padding:4px 8px;border-radius:4px;opacity:0.85;'
	document.body.appendChild(hint)

	document.body.appendChild(host)

	let visible = false
	const setVisible = (next: boolean): void => {
		visible = next
		host.style.display = visible ? 'block' : 'none'
		hint.style.display = visible ? 'none' : 'block'
	}

	const refresh = (): void => {
		if (!visible) return
		renderDevtoolsPanel(panelRoot, instrumenter.getBuffer().getAll())
	}

	const intervalId = window.setInterval(refresh, 300)

	const onKeyDown = (event: KeyboardEvent): void => {
		const isToggle = event.key === 'K' && event.shiftKey && (event.ctrlKey || event.metaKey)
		if (!isToggle) return
		event.preventDefault()
		setVisible(!visible)
		if (visible) {
			refresh()
		}
	}

	window.addEventListener('keydown', onKeyDown)

	return () => {
		window.clearInterval(intervalId)
		window.removeEventListener('keydown', onKeyDown)
		host.remove()
		hint.remove()
	}
}
