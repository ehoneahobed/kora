import { KoraError } from '@korajs/core'
import { defineCommand } from 'citty'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { runCli } from './run-cli'

class Exited extends Error {}

describe('runCli prints a failure once', () => {
	let output: string[]
	beforeEach(() => {
		output = []
		const capture = (...parts: unknown[]) => {
			output.push(parts.map(String).join(' '))
		}
		vi.spyOn(console, 'log').mockImplementation(capture)
		vi.spyOn(console, 'error').mockImplementation(capture)
		vi.spyOn(console, 'warn').mockImplementation(capture)
		vi.spyOn(process, 'exit').mockImplementation((() => {
			throw new Exited()
		}) as never)
	})
	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
	})

	const failing = (error: Error) =>
		defineCommand({
			meta: { name: 'kora' },
			subCommands: {
				go: defineCommand({ meta: { name: 'go' }, run: () => Promise.reject(error) }),
			},
		})

	test('a plain error: its message once, no stack, and how to see it', async () => {
		await expect(
			runCli(failing(new Error('Missing app name in --confirm mode.')), ['go']),
		).rejects.toBeInstanceOf(Exited)
		const text = output.join('\n')
		expect(text.match(/Missing app name in --confirm mode\./g)).toHaveLength(1)
		expect(text).not.toMatch(/\n\s+at /)
		expect(text).toMatch(/KORA_DEBUG=1/)
	})

	test('with KORA_DEBUG the stack is shown too, still with the message once', async () => {
		vi.stubEnv('KORA_DEBUG', '1')
		await expect(runCli(failing(new Error('boom')), ['go'])).rejects.toBeInstanceOf(Exited)
		const text = output.join('\n')
		expect(text).toMatch(/at /)
		expect(text.match(/boom/g)?.length).toBeLessThanOrEqual(2)
	})

	test('a KoraError: only its message', async () => {
		await expect(
			runCli(failing(new KoraError('Not signed in.', 'X')), ['go']),
		).rejects.toBeInstanceOf(Exited)
		const text = output.join('\n')
		expect(text.match(/Not signed in\./g)).toHaveLength(1)
		expect(text).not.toMatch(/KORA_DEBUG/)
	})
})
