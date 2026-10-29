import { describe, expect, it } from 'vitest'
import { createFakeRegistry } from '../../tests/fixtures/upgrade-projects'
import { UpgradeError } from '../errors'
import { createHttpRegistryLookup, isUpgradeTag, resolveTargetVersion } from './registry'

const NAMES = ['@korajs/react', 'korajs']
const VERSIONS = ['1.0.0-beta.14', '1.0.0-beta.15', '1.0.0-canary.2', '1.0.0']

describe('isUpgradeTag', () => {
	it('accepts the three supported tags only', () => {
		expect(isUpgradeTag('beta')).toBe(true)
		expect(isUpgradeTag('next')).toBe(false)
	})
})

describe('resolveTargetVersion', () => {
	const lookup = createFakeRegistry({
		distTags: { latest: '1.0.0', beta: '1.0.0-beta.15', canary: '1.0.0-canary.2' },
		versions: VERSIONS,
	})

	it('defaults to the beta tag for a project on a prerelease', async () => {
		const target = await resolveTargetVersion({
			packageNames: NAMES,
			lookup,
			currentVersions: ['1.0.0-beta.14'],
		})
		expect(target).toEqual({ version: '1.0.0-beta.15', source: 'tag', tag: 'beta' })
	})

	it('defaults to latest for a project on a release', async () => {
		const target = await resolveTargetVersion({
			packageNames: NAMES,
			lookup,
			currentVersions: ['0.9.0'],
		})
		expect(target.version).toBe('1.0.0')
	})

	it('honors --tag canary', async () => {
		const target = await resolveTargetVersion({
			packageNames: NAMES,
			lookup,
			tag: 'canary',
			currentVersions: ['1.0.0-beta.14'],
		})
		expect(target).toMatchObject({ version: '1.0.0-canary.2', tag: 'canary' })
	})

	it('accepts --to when every package has the version', async () => {
		const target = await resolveTargetVersion({
			packageNames: NAMES,
			lookup,
			to: 'v1.0.0-beta.14',
			currentVersions: [],
		})
		expect(target).toEqual({ version: '1.0.0-beta.14', source: 'to' })
	})

	it('rejects --to for an unpublished version, naming the packages', async () => {
		const partial = createFakeRegistry({
			distTags: {},
			versions: [],
			perPackage: {
				korajs: { distTags: {}, versions: ['1.0.0-beta.16'] },
				'@korajs/react': { distTags: {}, versions: [] },
			},
		})
		await expect(
			resolveTargetVersion({
				packageNames: NAMES,
				lookup: partial,
				to: '1.0.0-beta.16',
				currentVersions: [],
			}),
		).rejects.toMatchObject({ code: 'UPGRADE_VERSION_NOT_PUBLISHED' })
	})

	it('rejects a malformed --to', async () => {
		await expect(
			resolveTargetVersion({ packageNames: NAMES, lookup, to: 'beta', currentVersions: [] }),
		).rejects.toMatchObject({ code: 'UPGRADE_INVALID_VERSION' })
	})

	it('fails when a package is not published at all', async () => {
		await expect(
			resolveTargetVersion({
				packageNames: ['@korajs/ghost'],
				lookup,
				currentVersions: [],
			}),
		).rejects.toMatchObject({ code: 'UPGRADE_PACKAGE_NOT_PUBLISHED' })
	})

	it('fails when the tag is missing or the packages disagree on it', async () => {
		const noTag = createFakeRegistry({ distTags: { latest: '1.0.0' }, versions: VERSIONS })
		await expect(
			resolveTargetVersion({
				packageNames: NAMES,
				lookup: noTag,
				tag: 'canary',
				currentVersions: [],
			}),
		).rejects.toMatchObject({ code: 'UPGRADE_TAG_NOT_FOUND' })

		const split = createFakeRegistry({
			distTags: { latest: '1.0.0' },
			versions: VERSIONS,
			perPackage: { korajs: { distTags: { latest: '1.0.0-beta.15' }, versions: VERSIONS } },
		})
		await expect(
			resolveTargetVersion({
				packageNames: NAMES,
				lookup: split,
				tag: 'latest',
				currentVersions: [],
			}),
		).rejects.toBeInstanceOf(UpgradeError)
		await expect(
			resolveTargetVersion({
				packageNames: NAMES,
				lookup: split,
				tag: 'latest',
				currentVersions: [],
			}),
		).rejects.toMatchObject({ code: 'UPGRADE_TAG_MISMATCH' })
	})
})

describe('createHttpRegistryLookup', () => {
	it('requests the abbreviated document of a scoped package and parses it', async () => {
		const urls: string[] = []
		const fetchImpl = (async (url: string) => {
			urls.push(url)
			return new Response(
				JSON.stringify({
					'dist-tags': { latest: '1.0.0' },
					versions: { '1.0.0': {}, '0.9.0': {} },
				}),
				{ status: 200 },
			)
		}) as unknown as typeof fetch
		const lookup = createHttpRegistryLookup('https://registry.example.com/', fetchImpl)
		expect(await lookup('@korajs/core')).toEqual({
			distTags: { latest: '1.0.0' },
			versions: ['1.0.0', '0.9.0'],
		})
		expect(urls).toEqual(['https://registry.example.com/@korajs%2Fcore'])
	})

	it('returns null for 404 and throws a clear error for other failures', async () => {
		const notFound = createHttpRegistryLookup(
			'https://r.example.com',
			(async () => new Response('', { status: 404 })) as unknown as typeof fetch,
		)
		expect(await notFound('nope')).toBeNull()
		const broken = createHttpRegistryLookup(
			'https://r.example.com',
			(async () => new Response('', { status: 503 })) as unknown as typeof fetch,
		)
		await expect(broken('korajs')).rejects.toMatchObject({ code: 'UPGRADE_REGISTRY_ERROR' })
	})
})
