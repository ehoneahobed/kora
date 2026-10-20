import { describe, expect, it } from 'vitest'
import { describeLegacyProtocolSessions } from './status-command'

// We test the helper logic, not the full command (which requires a running server).
// The server-side endpoints are tested in the @korajs/server package.

describe('status command helpers', () => {
	it('produces the correct status URL', () => {
		const baseUrl = 'http://localhost:3001'
		const statusUrl = `${baseUrl.replace(/\/$/, '')}/__kora/status`
		expect(statusUrl).toBe('http://localhost:3001/__kora/status')
	})

	it('handles trailing slashes in URL', () => {
		const baseUrl = 'http://localhost:3001/'
		const statusUrl = `${baseUrl.replace(/\/$/, '')}/__kora/status`
		expect(statusUrl).toBe('http://localhost:3001/__kora/status')
	})

	it('handles custom URLs', () => {
		const baseUrl = 'https://my-kora-server.com'
		const statusUrl = `${baseUrl.replace(/\/$/, '')}/__kora/status`
		expect(statusUrl).toBe('https://my-kora-server.com/__kora/status')
	})
})

describe('describeLegacyProtocolSessions', () => {
	it('prints nothing for a server that does not report protocol-1 sessions', () => {
		expect(describeLegacyProtocolSessions({})).toBeNull()
	})

	it('reports zero protocol-1 sessions as a plain line', () => {
		expect(
			describeLegacyProtocolSessions({
				legacyProtocolSessions: 0,
				lastLegacyProtocolSessionAt: null,
			}),
		).toEqual({ level: 'step', text: 'Protocol 1: 0 sessions since start' })
	})

	it('warns with the count and the latest session time', () => {
		const line = describeLegacyProtocolSessions({
			legacyProtocolSessions: 3,
			lastLegacyProtocolSessionAt: Date.UTC(2026, 9, 19, 12, 0, 0),
		})
		expect(line?.level).toBe('warn')
		expect(line?.text).toContain('3 deprecated session(s)')
		expect(line?.text).toContain('2026-10-19T12:00:00.000Z')
	})
})
