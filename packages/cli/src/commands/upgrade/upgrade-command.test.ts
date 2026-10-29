import { describe, expect, test } from 'vitest'
import { upgradeCommand } from './upgrade-command'

describe('upgradeCommand', () => {
	test('is registered with expected meta and safe defaults', () => {
		expect(upgradeCommand.meta?.name).toBe('upgrade')
		expect(upgradeCommand.args?.['dry-run']?.default).toBe(false)
		expect(upgradeCommand.args?.yes?.default).toBe(false)
		expect(upgradeCommand.args?.['allow-downgrade']?.default).toBe(false)
		expect(upgradeCommand.args?.['apply-codemods']?.default).toBe(false)
		expect(upgradeCommand.args?.tag?.type).toBe('string')
		expect(upgradeCommand.args?.to?.type).toBe('string')
	})
})
