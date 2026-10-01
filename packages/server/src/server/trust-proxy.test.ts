import { describe, expect, test } from 'vitest'
import { resolveClientIp } from './trust-proxy'

describe('resolveClientIp', () => {
	test('without trustProxy, X-Forwarded-For is ignored', () => {
		expect(resolveClientIp('198.51.100.9', '203.0.113.77', undefined)).toBe('198.51.100.9')
	})

	test('hop count 1 takes the right-most forwarded entry (the one the proxy appended)', () => {
		expect(resolveClientIp('10.0.0.2', 'spoofed, 203.0.113.5', 1)).toBe('203.0.113.5')
	})

	test('hop count 2 walks one more trusted proxy', () => {
		expect(resolveClientIp('10.0.0.2', 'spoofed, 203.0.113.5, 10.0.0.3', 2)).toBe('203.0.113.5')
	})

	test('hop count larger than the chain stops at the left-most entry', () => {
		expect(resolveClientIp('10.0.0.2', '203.0.113.5', 5)).toBe('203.0.113.5')
	})

	test('hop count 0 or invalid trusts nobody', () => {
		expect(resolveClientIp('10.0.0.2', '203.0.113.5', 0)).toBe('10.0.0.2')
		expect(resolveClientIp('10.0.0.2', '203.0.113.5', -1)).toBe('10.0.0.2')
		expect(resolveClientIp('10.0.0.2', '203.0.113.5', 1.5)).toBe('10.0.0.2')
	})

	test('a CIDR list trusts only matching peers', () => {
		const trusted = ['10.0.0.0/8']
		expect(resolveClientIp('10.1.2.3', '203.0.113.5', trusted)).toBe('203.0.113.5')
		// A direct client outside the trusted range cannot choose its address.
		expect(resolveClientIp('198.51.100.9', '203.0.113.5', trusted)).toBe('198.51.100.9')
	})

	test('a CIDR list skips every trusted proxy and stops at the first untrusted hop', () => {
		const trusted = ['10.0.0.0/8', '192.168.1.1']
		expect(
			resolveClientIp('10.0.0.1', 'spoofed, 203.0.113.5, 192.168.1.1, 10.9.9.9', trusted),
		).toBe('203.0.113.5')
	})

	test('IPv4-mapped IPv6 socket addresses match IPv4 ranges', () => {
		expect(resolveClientIp('::ffff:10.0.0.7', '203.0.113.5', ['10.0.0.0/24'])).toBe('203.0.113.5')
	})

	test('IPv6 ranges and exact addresses', () => {
		expect(resolveClientIp('::1', '2001:db8::5', ['::1'])).toBe('2001:db8::5')
		expect(resolveClientIp('fd00::1:2', '2001:db8::5', ['fd00::/8'])).toBe('2001:db8::5')
		expect(resolveClientIp('2001:db8::9', '2001:db8::5', ['fd00::/8'])).toBe('2001:db8::9')
	})

	test('malformed ranges and addresses are never trusted', () => {
		expect(resolveClientIp('10.0.0.1', '203.0.113.5', ['not-an-ip', '10.0.0.0/99'])).toBe(
			'10.0.0.1',
		)
		expect(resolveClientIp('garbage', '203.0.113.5', ['10.0.0.0/8'])).toBe('garbage')
	})

	test('multiple header values are joined in order', () => {
		expect(resolveClientIp('10.0.0.2', ['a.example', '203.0.113.5'], 1)).toBe('203.0.113.5')
	})

	test('no socket address yields undefined', () => {
		expect(resolveClientIp(undefined, '203.0.113.5', 1)).toBeUndefined()
	})
})
