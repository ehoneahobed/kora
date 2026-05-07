/**
 * Shared utility functions for DevTools panel components.
 */

export function formatTime(timestamp: number): string {
	const d = new Date(timestamp)
	const h = String(d.getHours()).padStart(2, '0')
	const m = String(d.getMinutes()).padStart(2, '0')
	const s = String(d.getSeconds()).padStart(2, '0')
	const ms = String(d.getMilliseconds()).padStart(3, '0')
	return `${h}:${m}:${s}.${ms}`
}

export function formatDuration(ms: number): string {
	if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`
	if (ms < 1000) return `${ms.toFixed(1)}ms`
	return `${(ms / 1000).toFixed(2)}s`
}

export function truncate(str: string, max: number): string {
	if (str.length <= max) return str
	return str.slice(0, max - 1) + '…'
}

export function formatValue(value: unknown): string {
	if (value === null || value === undefined) return 'null'
	if (typeof value === 'string') return `"${value}"`
	if (typeof value === 'object') return JSON.stringify(value, null, 2)
	return String(value)
}
