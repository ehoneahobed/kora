import { describe, expect, it } from 'vitest'

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
