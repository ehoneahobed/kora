#!/usr/bin/env node
/**
 * Deterministic beta version bump.
 *
 * Moves every publishable package from `X.Y.Z-beta.N` to `X.Y.Z-beta.(N+1)`,
 * preserving each package's stable base (`X.Y.Z`) exactly. It can ONLY advance
 * the trailing beta counter — a base change (major/minor/patch) is impossible by
 * construction. This is the guardrail against changesets' version computation
 * ever surprising the beta line again: for each beta you cut, run this instead of
 * `changeset version`.
 *
 * The top-level `"version"` line is edited in place so the rest of each
 * package.json (including `workspace:*` dependency ranges) is left byte-for-byte
 * untouched.
 *
 * Usage:
 *   node scripts/release/bump-beta.mjs            # bump every publishable package
 *   node scripts/release/bump-beta.mjs --dry-run  # preview without writing
 *
 * Then publish under the beta dist-tag:
 *   pnpm build && changeset publish   (or: pnpm -r publish --tag beta)
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dryRun = process.argv.includes('--dry-run')

/** Workspace package directories. */
const dirs = ['kora', 'create-kora-app']
for (const entry of readdirSync('packages')) {
	dirs.push(join('packages', entry))
}

/** Match the first top-level "version": "..." line, capturing prefix/value/suffix. */
const VERSION_LINE = /^(\s*"version"\s*:\s*")([^"]+)(".*)$/m
/** A prerelease version on the -beta.N track. */
const BETA_VERSION = /^(\d+\.\d+\.\d+)-beta\.(\d+)$/

const bumped = []
const skipped = []

for (const dir of dirs) {
	const pkgPath = join(dir, 'package.json')
	if (!existsSync(pkgPath)) {
		continue
	}
	const raw = readFileSync(pkgPath, 'utf8')
	const pkg = JSON.parse(raw)
	if (pkg.private === true) {
		continue
	}
	const match = BETA_VERSION.exec(pkg.version ?? '')
	if (!match) {
		skipped.push(`${pkg.name}@${pkg.version ?? '(none)'} — not on a -beta.N track`)
		continue
	}
	const base = match[1]
	const next = `${base}-beta.${Number(match[2]) + 1}`
	if (!dryRun) {
		const updated = raw.replace(VERSION_LINE, `$1${next}$3`)
		if (updated === raw) {
			throw new Error(`Failed to rewrite version in ${pkgPath}`)
		}
		writeFileSync(pkgPath, updated)
	}
	bumped.push({ name: pkg.name, from: pkg.version, to: next, base })
}

// Safety: the changeset "linked" group is meant to share one version. Read the
// group from config and warn if its members drifted onto different bases, so a
// human looks before publishing. Packages outside the group (for example
// @korajs/tauri) have their own version lines and are not checked.
let linkedGroup = new Set()
try {
	const config = JSON.parse(readFileSync(join('.changeset', 'config.json'), 'utf8'))
	linkedGroup = new Set((config.linked?.[0] ?? []).flat())
} catch {
	// No config or no linked group: skip the uniformity check.
}
const linkedBases = new Set(bumped.filter((p) => linkedGroup.has(p.name)).map((p) => p.base))
if (linkedBases.size > 1) {
	console.warn(
		`\n⚠  The linked packages are not on a single base (${[...linkedBases].join(', ')}). ` +
			'They are meant to version together; align them before publishing.',
	)
}

console.log(dryRun ? 'DRY RUN — no files written.\n' : 'Bumped beta versions:\n')
for (const p of bumped) {
	console.log(`  ${p.name}: ${p.from} -> ${p.to}`)
}
if (skipped.length > 0) {
	console.log('\nLeft untouched (not on a -beta.N track):')
	for (const s of skipped) {
		console.log(`  ${s}`)
	}
}
