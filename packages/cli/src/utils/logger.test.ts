import { describe, expect, test, vi } from 'vitest'
import { createLogger } from './logger'

describe('createLogger', () => {
	test('info writes to console.log', () => {
		const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
		const logger = createLogger({ noColor: true })
		logger.info('hello')
		expect(spy).toHaveBeenCalledWith('hello')
		spy.mockRestore()
	})

	test('success writes with checkmark prefix', () => {
		const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
		const logger = createLogger({ noColor: true })
		logger.success('done')
		expect(spy).toHaveBeenCalledWith('  ✓ done')
		spy.mockRestore()
	})

	test('warn writes to console.warn', () => {
		const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const logger = createLogger({ noColor: true })
		logger.warn('careful')
		expect(spy).toHaveBeenCalledWith('  ⚠ careful')
		spy.mockRestore()
	})

	test('error writes to console.error', () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
		const logger = createLogger({ noColor: true })
		logger.error('failed')
		expect(spy).toHaveBeenCalledWith('  ✗ failed')
		spy.mockRestore()
	})

	test('step writes dimmed message', () => {
		const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
		const logger = createLogger({ noColor: true })
		logger.step('working...')
		expect(spy).toHaveBeenCalledWith('  working...')
		spy.mockRestore()
	})

	test('blank writes empty line', () => {
		const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
		const logger = createLogger({ noColor: true })
		logger.blank()
		expect(spy).toHaveBeenCalledWith()
		spy.mockRestore()
	})

	test('banner writes Kora.js header', () => {
		const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
		const logger = createLogger({ noColor: true })
		logger.banner()
		const calls = spy.mock.calls.flat().join('\n')
		expect(calls).toContain('Kora.js')
		spy.mockRestore()
	})
})
