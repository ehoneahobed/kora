import { describe, expect, it } from 'vitest'
import { MemoryServerStore } from '../store/memory-server-store'
import { parseTrustProxy, withHostSettings } from './host-settings'

const store = new MemoryServerStore('server-1')

describe('withHostSettings', () => {
	it('takes the proxy setting and operational tokens the host sets', () => {
		const config = withHostSettings(
			{ store },
			{
				KORA_TRUST_PROXY: '1',
				KORA_ADMIN_TOKEN: 'admin',
				KORA_METRICS_TOKEN: 'metrics',
				KORA_BACKUP_TOKEN: 'backup',
			},
		)
		expect(config.trustProxy).toBe(1)
		expect(config.operationalAuth).toEqual({
			adminToken: 'admin',
			metricsToken: 'metrics',
			backupToken: 'backup',
		})
	})

	it('never overrides what the app passes', () => {
		const config = withHostSettings(
			{
				store,
				trustProxy: ['10.0.0.0/8'],
				operationalAuth: { adminToken: 'mine', allowPublic: true },
			},
			{ KORA_TRUST_PROXY: '2', KORA_ADMIN_TOKEN: 'host' },
		)
		expect(config.trustProxy).toEqual(['10.0.0.0/8'])
		expect(config.operationalAuth).toEqual({ adminToken: 'mine', allowPublic: true })
	})

	it('leaves everything unset when the host sets nothing', () => {
		const config = withHostSettings({ store }, {})
		expect(config.trustProxy).toBeUndefined()
		expect(config.operationalAuth).toEqual({})
	})
})

describe('parseTrustProxy', () => {
	it('reads a hop count or a list of ranges', () => {
		expect(parseTrustProxy('1')).toBe(1)
		expect(parseTrustProxy('0')).toBeUndefined()
		expect(parseTrustProxy('10.0.0.0/8, ::1')).toEqual(['10.0.0.0/8', '::1'])
		expect(parseTrustProxy('')).toBeUndefined()
		expect(parseTrustProxy('yes please')).toBeUndefined()
	})
})
