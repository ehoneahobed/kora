import { describe, expect, test } from 'vitest'
import { compactCommand } from './compact-command'

describe('compactCommand', () => {
	test('is registered with expected meta', () => {
		expect(compactCommand.meta?.name).toBe('compact')
		expect(compactCommand.args?.strategy?.default).toBe('after-ack')
	})
})
