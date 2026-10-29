import { describe, expect, it } from 'vitest'
import { UpgradeError } from '../errors'
import { buildUpgradePlan, classifySpecifiers, formatSpecifier } from './plan'
import type { KoraSpecifier } from './project'

function spec(name: string, value: string, section = 'dependencies'): KoraSpecifier {
	return {
		format: 'package-json',
		file: '/p/package.json',
		section,
		path: [section],
		name,
		spec: value,
	}
}

const TARGET = { version: '1.0.0-beta.15', source: 'tag' as const, tag: 'beta' as const }

describe('classifySpecifiers', () => {
	it('keeps simple versions bumpable and explains every skip', () => {
		const { bumpable, skipped } = classifySpecifiers([
			spec('korajs', '^1.0.0-beta.14'),
			spec('@korajs/core', '~1.0.0-beta.14'),
			spec('@korajs/store', '1.0.0-beta.14'),
			spec('@korajs/sync', 'workspace:*'),
			spec('@korajs/server', 'catalog:'),
			spec('@korajs/react', 'beta'),
			spec('@korajs/merge', '>=1.0.0-beta.1 <2'),
			spec('@korajs/auth', 'file:../auth'),
		])
		expect(bumpable.map((b) => [b.specifier.name, b.style])).toEqual([
			['korajs', 'caret'],
			['@korajs/core', 'tilde'],
			['@korajs/store', 'exact'],
		])
		const reasons = Object.fromEntries(skipped.map((s) => [s.specifier.name, s.reason]))
		expect(reasons['@korajs/sync']).toContain('workspace')
		expect(reasons['@korajs/server']).toContain('catalog')
		expect(reasons['@korajs/react']).toContain('dist-tag')
		expect(reasons['@korajs/merge']).toContain('complex range')
		expect(reasons['@korajs/auth']).toContain('not a registry version')
	})
})

describe('formatSpecifier', () => {
	it('writes the three styles', () => {
		expect(formatSpecifier('caret', '1.0.0')).toBe('^1.0.0')
		expect(formatSpecifier('tilde', '1.0.0')).toBe('~1.0.0')
		expect(formatSpecifier('exact', '1.0.0')).toBe('1.0.0')
	})
})

describe('buildUpgradePlan', () => {
	it('moves every package to the target in its own style and flags mixed styles', () => {
		const plan = buildUpgradePlan(
			classifySpecifiers([
				spec('korajs', '^1.0.0-beta.14'),
				spec('@korajs/react', '1.0.0-beta.14'),
				spec('@korajs/cli', '^1.0.0-beta.15', 'devDependencies'),
			]),
			TARGET,
		)
		expect(plan.changes.map((c) => [c.specifier.name, c.to])).toEqual([
			['korajs', '^1.0.0-beta.15'],
			['@korajs/react', '1.0.0-beta.15'],
		])
		expect(plan.unchanged.map((u) => u.specifier.name)).toEqual(['@korajs/cli'])
		expect(plan.packageNames).toEqual(['@korajs/cli', '@korajs/react', 'korajs'])
		expect(plan.currentVersion).toBe('1.0.0-beta.14')
		expect(plan.warnings.join('\n')).toContain('mix styles')
		expect(plan.warnings.join('\n')).toContain('different versions')
	})

	it('has no warnings for a consistent project', () => {
		const plan = buildUpgradePlan(
			classifySpecifiers([
				spec('korajs', '^1.0.0-beta.14'),
				spec('@korajs/react', '^1.0.0-beta.14'),
			]),
			TARGET,
		)
		expect(plan.warnings).toEqual([])
	})

	it('refuses a downgrade unless allowed', () => {
		const classified = classifySpecifiers([spec('korajs', '^1.0.0-beta.16')])
		expect(() => buildUpgradePlan(classified, TARGET)).toThrow(UpgradeError)
		const plan = buildUpgradePlan(classified, TARGET, { allowDowngrade: true })
		expect(plan.changes).toHaveLength(1)
		expect(plan.warnings[0]).toContain('Downgrading')
	})
})
