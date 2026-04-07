import { describe, expect, test, vi } from 'vitest'
import * as promptUtils from '../utils/prompt'
import {
	ClackPromptClient,
	createPromptClient,
	PromptCancelledError,
	ReadlinePromptClient,
} from './prompt-client'

describe('ReadlinePromptClient', () => {
	test('delegates text prompts to promptText', async () => {
		const spy = vi.spyOn(promptUtils, 'promptText').mockResolvedValue('hello')
		const client = new ReadlinePromptClient()

		const result = await client.text('Message', 'default')

		expect(result).toBe('hello')
		expect(spy).toHaveBeenCalledWith('Message', 'default')
		spy.mockRestore()
	})

	test('delegates select prompts to promptSelect', async () => {
		const spy = vi.spyOn(promptUtils, 'promptSelect').mockResolvedValue('a')
		const client = new ReadlinePromptClient()

		const result = await client.select('Pick one', [
			{ label: 'A', value: 'a' as const },
			{ label: 'B', value: 'b' as const },
		])

		expect(result).toBe('a')
		expect(spy).toHaveBeenCalledTimes(1)
		spy.mockRestore()
	})

	test('delegates confirm prompts to promptConfirm', async () => {
		const spy = vi.spyOn(promptUtils, 'promptConfirm').mockResolvedValue(true)
		const client = new ReadlinePromptClient()

		const result = await client.confirm('Proceed?', true)

		expect(result).toBe(true)
		expect(spy).toHaveBeenCalledWith('Proceed?', true)
		spy.mockRestore()
	})
})

describe('createPromptClient', () => {
	test('returns a ReadlinePromptClient instance', () => {
		const client = createPromptClient()
		if (process.stdin.isTTY && process.stdout.isTTY) {
			expect(client).toBeInstanceOf(ClackPromptClient)
			return
		}
		expect(client).toBeInstanceOf(ReadlinePromptClient)
	})
})

describe('PromptCancelledError', () => {
	test('uses a stable error name', () => {
		const error = new PromptCancelledError()
		expect(error.name).toBe('PromptCancelledError')
	})
})
