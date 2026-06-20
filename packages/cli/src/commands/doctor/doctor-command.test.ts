import { describe, expect, test } from 'vitest'
import { doctorCommand } from './doctor-command'

describe('doctorCommand', () => {
	test('is registered with expected meta', () => {
		expect(doctorCommand.meta?.name).toBe('doctor')
		expect(doctorCommand.args?.['skip-network']?.default).toBe(false)
	})
})
