/**
 * The in-page probe of the parity benchmark. The build inlines it (as a classic script) at the
 * top of `<head>` in both apps, so it runs before any app code and sees the whole page life:
 * paint timing, main-thread stalls, clicks, and the first arrival of each sync message type.
 * Observation only: it changes nothing the apps do.
 */
import type { ParityProbe } from './parity-types'

/** The subset of `PerformanceElementTiming` the probe reads (not in TypeScript's DOM lib). */
interface ElementTimingEntry extends PerformanceEntry {
	identifier: string
	renderTime: number
	loadTime: number
}

function isElementTiming(entry: PerformanceEntry): entry is ElementTimingEntry {
	return 'identifier' in entry && 'renderTime' in entry
}

const probe: ParityProbe = {
	events: [],
	stalls: [],
	fcp: null,
	shellPaint: null,
	mark(name, detail) {
		probe.events.push({ name, ...detail, t: performance.now() })
	},
}
window.__parity = probe

// Main-thread blocking: a 10 ms timer whose tick arrives late was blocked for the delay.
let lastTick = performance.now()
setInterval(() => {
	const now = performance.now()
	const gap = now - lastTick - 10
	lastTick = now
	if (gap > 50) probe.stalls.push([now - gap, gap])
}, 10)

try {
	new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) {
			if (entry.name === 'first-contentful-paint' && probe.fcp === null) probe.fcp = entry.startTime
		}
	}).observe({ type: 'paint', buffered: true })
} catch {
	// Paint timing unavailable: fcp stays null and the harness reports it.
}

try {
	new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) {
			if (isElementTiming(entry) && entry.identifier === 'app-shell' && probe.shellPaint === null) {
				probe.shellPaint = entry.renderTime > 0 ? entry.renderTime : entry.loadTime
			}
		}
	}).observe({ type: 'element', buffered: true })
} catch {
	// Element timing unavailable: the harness falls back to the shell's layout mark.
}

// Clicks, timed from the event's own timestamp (the instant the input reached the page).
document.addEventListener(
	'click',
	(event) => {
		const target = event.target instanceof Element ? event.target.closest('[data-action]') : null
		if (target === null) return
		probe.events.push({
			name: 'click',
			screen: target.getAttribute('data-action') ?? '',
			id: target.getAttribute('data-id') ?? '',
			t: event.timeStamp,
		})
	},
	true,
)

// Timings reported by the app's own workers (epoch milliseconds), converted to page time.
try {
	new BroadcastChannel('kora-parity-probe').onmessage = (event: MessageEvent) => {
		const data: unknown = event.data
		if (typeof data !== 'object' || data === null) return
		const { name, at } = data as { name?: unknown; at?: unknown }
		if (typeof name === 'string' && typeof at === 'number') {
			probe.events.push({ name, t: at - performance.timeOrigin })
		}
	}
} catch {
	// No BroadcastChannel: worker phases are reported as n/a.
}

// The first arrival of each sync message type (handshake response, first operation batch).
// A prefix match on the message text, not a parse.
const seenMessageTypes = new Set<string>()
const NativeWebSocket = window.WebSocket
class ProbedWebSocket extends NativeWebSocket {
	constructor(url: string | URL, protocols?: string | string[]) {
		super(url, protocols)
		probe.mark('ws:open-requested')
		this.addEventListener('message', (event: MessageEvent) => {
			const data: unknown = event.data
			if (typeof data !== 'string') return
			const match = /"type":"([a-z-]+)"/.exec(data.slice(0, 160))
			const type = match?.[1] ?? 'unknown'
			if (seenMessageTypes.has(type)) return
			seenMessageTypes.add(type)
			probe.mark(`ws:${type}`)
		})
	}
}
window.WebSocket = ProbedWebSocket
