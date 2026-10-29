import { UpgradeError } from '../errors'
import type { KoraSpecifier } from './project'
import type { ResolvedTarget } from './registry'
import { compareVersions, parseVersion } from './semver'

/** How a version is written in a manifest; the upgrade keeps each specifier's own style. */
export type SpecifierStyle = 'caret' | 'tilde' | 'exact'

const SIMPLE_SPEC = /^([\^~])?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/

export interface BumpableSpecifier {
	specifier: KoraSpecifier
	style: SpecifierStyle
	/** The exact version inside the specifier. */
	version: string
}

export interface SkippedSpecifier {
	specifier: KoraSpecifier
	reason: string
}

export interface ClassifiedSpecifiers {
	bumpable: BumpableSpecifier[]
	skipped: SkippedSpecifier[]
}

function skipReason(spec: string): string {
	if (spec.startsWith('workspace:')) return 'workspace link (resolved from this repository)'
	if (spec.startsWith('catalog:')) return 'managed by a pnpm catalog (the catalog entry is bumped)'
	if (/^(file|link|portal|git|git\+|github|https?):/.test(spec)) return 'not a registry version'
	if (spec.startsWith('npm:')) return 'registry alias; update it by hand'
	if (spec === '*' || spec === 'latest' || /^[a-z][a-z-]*$/.test(spec)) {
		return 'a dist-tag or wildcard; the package manager already follows it'
	}
	return 'complex range; update it by hand'
}

/**
 * Splits specifiers into those `kora upgrade` can rewrite (`1.2.3`, `^1.2.3`, `~1.2.3`) and
 * those it leaves alone, with the reason (workspace links, catalog references, tags, ranges).
 */
export function classifySpecifiers(specifiers: KoraSpecifier[]): ClassifiedSpecifiers {
	const bumpable: BumpableSpecifier[] = []
	const skipped: SkippedSpecifier[] = []
	for (const specifier of specifiers) {
		const match = SIMPLE_SPEC.exec(specifier.spec.trim())
		if (!match || !match[2]) {
			skipped.push({ specifier, reason: skipReason(specifier.spec.trim()) })
			continue
		}
		const style: SpecifierStyle = match[1] === '^' ? 'caret' : match[1] === '~' ? 'tilde' : 'exact'
		bumpable.push({ specifier, style, version: match[2] })
	}
	return { bumpable, skipped }
}

/** Writes `version` in the given style: `^1.0.0`, `~1.0.0` or `1.0.0`. */
export function formatSpecifier(style: SpecifierStyle, version: string): string {
	return `${style === 'caret' ? '^' : style === 'tilde' ? '~' : ''}${version}`
}

export interface PlannedChange {
	specifier: KoraSpecifier
	style: SpecifierStyle
	from: string
	to: string
}

export interface UpgradePlan {
	target: ResolvedTarget
	/** Specifiers that will be rewritten. */
	changes: PlannedChange[]
	/** Specifiers already on the target version. */
	unchanged: BumpableSpecifier[]
	skipped: SkippedSpecifier[]
	/** Distinct Kora package names that move together. */
	packageNames: string[]
	/** Lowest exact version declared today, used to pick which codemods apply. Null if none. */
	currentVersion: string | null
	warnings: string[]
}

export interface BuildPlanOptions {
	allowDowngrade?: boolean
}

/**
 * Builds the plan that moves every bumpable specifier to the target version, in the style it
 * already uses. Throws {@link UpgradeError} on a downgrade unless `allowDowngrade` is set.
 * Pure: reads and writes nothing.
 */
export function buildUpgradePlan(
	classified: ClassifiedSpecifiers,
	target: ResolvedTarget,
	options: BuildPlanOptions = {},
): UpgradePlan {
	const warnings: string[] = []
	const changes: PlannedChange[] = []
	const unchanged: BumpableSpecifier[] = []

	const versions = classified.bumpable.map((entry) => entry.version).sort(compareVersions)
	const highest = versions[versions.length - 1]
	if (highest !== undefined && compareVersions(highest, target.version) > 0) {
		if (!options.allowDowngrade) {
			throw new UpgradeError(
				`${target.version} is older than the ${highest} already in your project. Pass --allow-downgrade if you really want to go back.`,
				'UPGRADE_DOWNGRADE',
				{ highest, target: target.version },
			)
		}
		warnings.push(`Downgrading from ${highest} to ${target.version}.`)
	}

	for (const entry of classified.bumpable) {
		const to = formatSpecifier(entry.style, target.version)
		if (entry.version === target.version) unchanged.push(entry)
		else
			changes.push({
				specifier: entry.specifier,
				style: entry.style,
				from: entry.specifier.spec,
				to,
			})
	}

	const distinctVersions = [...new Set(versions)]
	if (distinctVersions.length > 1) {
		warnings.push(
			`Kora packages are on different versions today (${distinctVersions.join(', ')}); this upgrade aligns them all to ${target.version}.`,
		)
	}

	const styles = new Map<SpecifierStyle, Set<string>>()
	for (const entry of classified.bumpable) {
		const names = styles.get(entry.style) ?? new Set<string>()
		names.add(entry.specifier.name)
		styles.set(entry.style, names)
	}
	if (styles.size > 1) {
		const detail = [...styles]
			.map(([style, names]) => `${style} (${[...names].join(', ')})`)
			.join('; ')
		warnings.push(
			`Specifiers mix styles: ${detail}. Each keeps its own style; ^ and ~ let a later install move past ${target.version}, so prefer one style.`,
		)
	}

	const packageNames = [...new Set(classified.bumpable.map((entry) => entry.specifier.name))].sort()
	const lowest = versions[0]
	return {
		target,
		changes,
		unchanged,
		skipped: classified.skipped,
		packageNames,
		currentVersion: lowest !== undefined && parseVersion(lowest) ? lowest : null,
		warnings,
	}
}
