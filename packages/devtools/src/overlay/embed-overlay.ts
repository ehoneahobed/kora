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
	style.textContent = `${KORA_DEVTOOLS_STYLES}
		:host {
			color-scheme: dark;
			background: #1e1e2e;
			color: #cdd6f4;
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
			overflow: hidden;
			border: 1px solid #45475a;
			box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
		}
		.kora-overlay-close {
			position: absolute;
			top: 6px;
			right: 8px;
			z-index: 1;
			background: #313244;
			color: #cdd6f4;
			border: 1px solid #45475a;
			border-radius: 4px;
			cursor: pointer;
			font: 12px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
			line-height: 1;
			padding: 4px 8px;
		}
		.kora-overlay-close:hover {
			background: #45475a;
		}
	`
	shadow.appendChild(style)

	const closeButton = document.createElement('button')
	closeButton.type = 'button'
	closeButton.className = 'kora-overlay-close'
	closeButton.textContent = 'Close'
	closeButton.setAttribute('aria-label', 'Close Kora DevTools')
	shadow.appendChild(closeButton)

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
		hint.textContent = visible ? 'Hide Kora DevTools (Esc)' : 'Kora DevTools (Ctrl+Shift+K)'
		hint.style.display = 'block'
	}

	const refresh = (): void => {
		if (!visible) return
		renderDevtoolsPanel(panelRoot, instrumenter.getBuffer().getAll())
	}

	const intervalId = window.setInterval(refresh, 300)

	const onKeyDown = (event: KeyboardEvent): void => {
		const isToggle = event.key === 'K' && event.shiftKey && (event.ctrlKey || event.metaKey)
		if (isToggle) {
			event.preventDefault()
			setVisible(!visible)
			if (visible) {
				refresh()
			}
			return
		}
		if (event.key === 'Escape' && visible) {
			event.preventDefault()
			setVisible(false)
		}
	}

	const onHintClick = (): void => {
		setVisible(!visible)
		if (visible) {
			refresh()
		}
	}

	const onCloseClick = (): void => {
		setVisible(false)
	}

	window.addEventListener('keydown', onKeyDown)
	hint.addEventListener('click', onHintClick)
	closeButton.addEventListener('click', onCloseClick)

	return () => {
		window.clearInterval(intervalId)
		window.removeEventListener('keydown', onKeyDown)
		hint.removeEventListener('click', onHintClick)
		closeButton.removeEventListener('click', onCloseClick)
		host.remove()
		hint.remove()
	}
}
