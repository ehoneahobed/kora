import { describe, expect, it } from 'vitest'

describe('logs command helpers', () => {
	it('produces the correct events URL', () => {
		const baseUrl = 'http://localhost:3001'
		const eventsUrl = `${baseUrl.replace(/\/$/, '')}/__kora/events`
		expect(eventsUrl).toBe('http://localhost:3001/__kora/events')
	})

	it('handles trailing slashes in URL', () => {
		const baseUrl = 'http://localhost:3001/'
		const eventsUrl = `${baseUrl.replace(/\/$/, '')}/__kora/events`
		expect(eventsUrl).toBe('http://localhost:3001/__kora/events')
	})
})
