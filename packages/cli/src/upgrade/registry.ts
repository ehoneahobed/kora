import { UpgradeError } from '../errors'
import { compareVersions, isPrerelease, normalizeVersion } from './semver'

/** What `kora upgrade` needs to know about one package on the registry. */
export interface PackageRegistryInfo {
	/** Dist-tags: `{ latest: '1.0.0', beta: '1.1.0-beta.1' }`. */
	distTags: Record<string, string>
	/** Every published version. */
	versions: string[]
}

/**
 * Looks a package up on the registry. Returns null when the package does not exist.
 * Injected so tests never touch the network; the default hits the npm registry over HTTPS.
 */
export type RegistryLookup = (packageName: string) => Promise<PackageRegistryInfo | null>

/** Dist-tags `--tag` accepts. */
export const UPGRADE_TAGS = ['latest', 'beta', 'canary'] as const
export type UpgradeTag = (typeof UPGRADE_TAGS)[number]

/** True when `value` is one of {@link UPGRADE_TAGS}. */
export function isUpgradeTag(value: string): value is UpgradeTag {
	return (UPGRADE_TAGS as readonly string[]).includes(value)
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return (
		typeof value === 'object' &&
		value !== null &&
		Object.values(value).every((entry) => typeof entry === 'string')
	)
}

/**
 * Default registry lookup: the abbreviated package document from the registry named by
 * `npm_config_registry` (default registry.npmjs.org). Private registries that need auth are
 * not supported; pass `--to <version>` on a machine that can reach the package.
 */
export function createHttpRegistryLookup(
	registryUrl: string = process.env.npm_config_registry ?? 'https://registry.npmjs.org',
	fetchImpl: typeof fetch = fetch,
): RegistryLookup {
	const base = registryUrl.replace(/\/+$/, '')
	return async (packageName) => {
		const response = await fetchImpl(`${base}/${packageName.replace('/', '%2F')}`, {
			headers: { accept: 'application/vnd.npm.install-v1+json' },
			signal: AbortSignal.timeout(15_000),
		})
		if (response.status === 404) return null
		if (!response.ok) {
			throw new UpgradeError(
				`The registry answered ${response.status} for ${packageName}. Check your connection, or pass --to <version> to skip the dist-tag lookup.`,
				'UPGRADE_REGISTRY_ERROR',
				{ packageName, status: response.status },
			)
		}
		const body: unknown = await response.json()
		const record =
			typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
		const distTags = isStringRecord(record['dist-tags']) ? record['dist-tags'] : {}
		const versionsField = record.versions
		const versions =
			typeof versionsField === 'object' && versionsField !== null ? Object.keys(versionsField) : []
		return { distTags, versions }
	}
}

export interface ResolveTargetOptions {
	/** Every Kora package name found in the project. */
	packageNames: string[]
	lookup: RegistryLookup
	/** `--tag`; ignored when `to` is set (the command refuses both together). */
	tag?: UpgradeTag
	/** `--to`: an exact version. */
	to?: string
	/** Exact versions currently declared, used to pick the default tag. */
	currentVersions: string[]
}

export interface ResolvedTarget {
	version: string
	source: 'to' | 'tag'
	tag?: UpgradeTag
}

/**
 * Chooses the one version every Kora package will be bumped to.
 *
 * - `--to <version>`: that exact version; every package must have it published.
 * - otherwise a dist-tag (`--tag`, default `beta` when the project is on a prerelease and
 *   has a `beta` tag, else `latest`); every package must resolve the tag to the same version,
 *   because upgrading to different versions per package is what this command prevents.
 */
export async function resolveTargetVersion(options: ResolveTargetOptions): Promise<ResolvedTarget> {
	const { packageNames, lookup } = options
	const infos = new Map<string, PackageRegistryInfo>()
	for (const name of packageNames) {
		const info = await lookup(name)
		if (!info) {
			throw new UpgradeError(
				`${name} is not published on the registry, so it cannot be upgraded. Remove it from package.json or pin it to a workspace/file path.`,
				'UPGRADE_PACKAGE_NOT_PUBLISHED',
				{ packageName: name },
			)
		}
		infos.set(name, info)
	}

	if (options.to !== undefined) {
		const version = normalizeVersion(options.to)
		if (!version) {
			throw new UpgradeError(
				`--to expects an exact version such as 1.0.0-beta.15, got "${options.to}".`,
				'UPGRADE_INVALID_VERSION',
				{ to: options.to },
			)
		}
		const missing = packageNames.filter((name) => !infos.get(name)?.versions.includes(version))
		if (missing.length > 0) {
			throw new UpgradeError(
				`Version ${version} is not published for: ${missing.join(', ')}. Pick a version every Kora package has.`,
				'UPGRADE_VERSION_NOT_PUBLISHED',
				{ version, missing },
			)
		}
		return { version, source: 'to' }
	}

	const tag: UpgradeTag =
		options.tag ??
		(options.currentVersions.some(isPrerelease) &&
		packageNames.every((name) => infos.get(name)?.distTags.beta !== undefined)
			? 'beta'
			: 'latest')

	const resolved = new Map<string, string>()
	const untagged: string[] = []
	for (const name of packageNames) {
		const tagged = infos.get(name)?.distTags[tag]
		const version = tagged === undefined ? null : normalizeVersion(tagged)
		if (version) resolved.set(name, version)
		else untagged.push(name)
	}
	if (untagged.length > 0) {
		throw new UpgradeError(
			`The "${tag}" dist-tag is not set for: ${untagged.join(', ')}. Choose another --tag or pass --to <version>.`,
			'UPGRADE_TAG_NOT_FOUND',
			{ tag, untagged },
		)
	}
	const distinct = [...new Set(resolved.values())].sort(compareVersions)
	if (distinct.length > 1) {
		const detail = [...resolved].map(([name, version]) => `${name}@${version}`).join(', ')
		throw new UpgradeError(
			`The "${tag}" dist-tag points at different versions (${detail}). A release may be half published; pass --to <version> to choose one.`,
			'UPGRADE_TAG_MISMATCH',
			{ tag, resolved: Object.fromEntries(resolved) },
		)
	}
	const [version] = distinct
	if (!version) {
		throw new UpgradeError('No Kora packages to resolve a target for.', 'UPGRADE_NO_PACKAGES')
	}
	return { version, source: 'tag', tag }
}
