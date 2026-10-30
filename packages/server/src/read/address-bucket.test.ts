import { describe, expect, test } from 'vitest'
import { addressBucket } from './address-bucket'

describe('addressBucket', () => {
	test('an IPv4 address is its own bucket', () => {
		expect(addressBucket('203.0.113.9')).toBe('203.0.113.9')
	})

	test('IPv6 addresses of one /64 share a bucket, other /64s do not', () => {
		expect(addressBucket('2001:db8:1:2::1')).toBe(addressBucket('2001:db8:1:2:abcd:ef01:2345:6789'))
		expect(addressBucket('2001:db8:1:2::1')).not.toBe(addressBucket('2001:db8:1:3::1'))
		expect(addressBucket('2001:DB8:1:2::1')).toBe(addressBucket('2001:db8:1:2::1'))
	})

	test('an IPv4-mapped address, in any spelling, is its IPv4 bucket', () => {
		for (const spelling of ['::ffff:1.2.3.4', '::ffff:102:304', '0:0:0:0:0:ffff:102:304']) {
			expect(addressBucket(spelling)).toBe('1.2.3.4')
		}
	})

	test('a zone id is ignored; no address is no bucket', () => {
		expect(addressBucket('fe80::1%eth0')).toBe(addressBucket('fe80::2'))
		expect(addressBucket(undefined)).toBeNull()
		expect(addressBucket('')).toBeNull()
	})
})
