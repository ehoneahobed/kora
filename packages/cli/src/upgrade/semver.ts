import { UpgradeError } from '../errors'

/**
 * Minimal semver support for `kora upgrade`: parse exact versions and compare them with
 * prerelease precedence. A full range engine is not needed because upgrade only ever
 * compares exact versions and rewrites simple `^`/`~`/exact specifiers.
 */

export interface ParsedVersion {
	major: number
	minor: number
	patch: number
	/** Dot-separated prerelease identifiers; empty for a release. */
	prerelease: string[]
}

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** Parses an exact version (`1.0.0-beta.14`); returns null for anything else. */
export function parseVersion(input: string): ParsedVersion | null {
	const match = VERSION_PATTERN.exec(input.trim())
	if (!match) return null
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		prerelease: match[4] ? match[4].split('.') : [],
	}
}

/** Strips a leading `v` and build metadata, returning the canonical exact version or null. */
export function normalizeVersion(input: string): string | null {
	const parsed = parseVersion(input)
	if (!parsed) return null
	const core = `${parsed.major}.${parsed.minor}.${parsed.patch}`
	return parsed.prerelease.length > 0 ? `${core}-${parsed.prerelease.join('.')}` : core
}

/** True when the version carries a prerelease tag (`-beta.14`). */
export function isPrerelease(version: string): boolean {
	return (parseVersion(version)?.prerelease.length ?? 0) > 0
}

function comparePrereleaseIdentifier(a: string, b: string): number {
	const aNumeric = /^\d+$/.test(a)
	const bNumeric = /^\d+$/.test(b)
	if (aNumeric && bNumeric) return Number(a) - Number(b)
	// Numeric identifiers sort below alphanumeric ones (semver 2.0.0, rule 11.4.3).
	if (aNumeric) return -1
	if (bNumeric) return 1
	return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Compares two exact versions: negative when a < b, positive when a > b, zero when equal.
 * Throws an UpgradeError for input that is not an exact version, because comparing garbage
 * silently would let an upgrade write the wrong target.
 */
export function compareVersions(a: string, b: string): number {
	const left = parseVersion(a)
	const right = parseVersion(b)
	if (!left || !right) {
		throw new UpgradeError(
			`Cannot compare non-exact versions "${a}" and "${b}".`,
			'UPGRADE_INVALID_VERSION',
			{ a, b },
		)
	}
	if (left.major !== right.major) return left.major - right.major
	if (left.minor !== right.minor) return left.minor - right.minor
	if (left.patch !== right.patch) return left.patch - right.patch
	// A release is greater than any of its prereleases.
	if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
	if (left.prerelease.length === 0) return 1
	if (right.prerelease.length === 0) return -1
	const length = Math.max(left.prerelease.length, right.prerelease.length)
	for (let i = 0; i < length; i++) {
		const l = left.prerelease[i]
		const r = right.prerelease[i]
		if (l === undefined) return -1
		if (r === undefined) return 1
		const result = comparePrereleaseIdentifier(l, r)
		if (result !== 0) return result
	}
	return 0
}
