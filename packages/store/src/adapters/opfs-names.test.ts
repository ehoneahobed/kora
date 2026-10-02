import { describe, expect, test } from 'vitest'
import {
	LEGACY_OPFS_POOL_NAME,
	fnv1a32Hex,
	leaderLockName,
	opfsDatabaseFilename,
	opfsPoolDirectory,
	opfsPoolLockName,
	opfsPoolNameFor,
	opfsPoolPath,
} from './opfs-names'

describe('opfs-names', () => {
	test('a safe database name maps to its own readable pool', () => {
		expect(opfsPoolNameFor('school__user_alice')).toBe('kora-opfs-school__user_alice')
		expect(opfsPoolDirectory('kora-opfs-x')).toBe('.kora-opfs-x')
		expect(opfsPoolLockName('kora-opfs-x')).toBe('kora-opfs-pool:kora-opfs-x')
	})

	test('per-database pools never collide with the legacy origin-wide pool', () => {
		expect(opfsPoolNameFor('')).not.toBe(LEGACY_OPFS_POOL_NAME)
		expect(opfsPoolNameFor('kora-opfs')).not.toBe(LEGACY_OPFS_POOL_NAME)
	})

	test('names that need sanitizing get a hash so distinct names never share a pool', () => {
		const a = opfsPoolNameFor('app.v1')
		const b = opfsPoolNameFor('app_v1')
		const c = opfsPoolNameFor('app v1')
		expect(new Set([a, b, c]).size).toBe(3)
		expect(a).toMatch(/^kora-opfs-app_v1-[0-9a-f]{8}$/)
		expect(b).toBe('kora-opfs-app_v1')
	})

	test('long names are truncated with a hash and stay unique', () => {
		const base = 'x'.repeat(80)
		const one = opfsPoolNameFor(`${base}1`)
		const two = opfsPoolNameFor(`${base}2`)
		expect(one).not.toBe(two)
		expect(one.length).toBeLessThanOrEqual('kora-opfs-'.length + 48 + 9)
	})

	test('pool names are deterministic', () => {
		expect(opfsPoolNameFor('a/b')).toBe(opfsPoolNameFor('a/b'))
		expect(fnv1a32Hex('kora')).toBe(fnv1a32Hex('kora'))
		expect(fnv1a32Hex('kora')).toMatch(/^[0-9a-f]{8}$/)
	})

	test('file names match beta.12 so legacy files can be found and moved', () => {
		expect(opfsDatabaseFilename('school__user_alice')).toBe('school__user_alice.db')
		expect(opfsDatabaseFilename('a b')).toBe('a_b.db')
		expect(opfsDatabaseFilename('x.db')).toBe('x.db')
		expect(opfsPoolPath('kora-db')).toBe('/kora-db.db')
		expect(leaderLockName('kora-db')).toBe('kora-leader-kora-db')
	})
})
