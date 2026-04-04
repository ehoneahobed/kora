import { PassThrough } from 'node:stream'
import { describe, expect, test } from 'vitest'
import { promptSelect, promptText } from './prompt'

function createMockStreams(inputData: string): {
	input: NodeJS.ReadableStream
	output: NodeJS.WritableStream
	getOutput: () => string
} {
	const input = new PassThrough()
	const output = new PassThrough()
	let outputData = ''
	output.on('data', (chunk: Buffer) => {
		outputData += chunk.toString()
	})

	// Write input data asynchronously to simulate user typing
	process.nextTick(() => {
		input.write(inputData)
		input.end()
	})

	return { input, output, getOutput: () => outputData }
}

describe('promptText', () => {
	test('returns user input', async () => {
		const { input, output } = createMockStreams('my-app\n')
		const result = await promptText('Project name', undefined, { input, output })
		expect(result).toBe('my-app')
	})

	test('returns default value when input is empty', async () => {
		const { input, output } = createMockStreams('\n')
		const result = await promptText('Project name', 'default-app', { input, output })
		expect(result).toBe('default-app')
	})

	test('trims whitespace from input', async () => {
		const { input, output } = createMockStreams('  my-app  \n')
		const result = await promptText('Project name', undefined, { input, output })
		expect(result).toBe('my-app')
	})
})

describe('promptSelect', () => {
	const choices = [
		{ label: 'React (basic)', value: 'react-basic' as const },
		{ label: 'React (with sync)', value: 'react-sync' as const },
	]

	test('returns selected value by number', async () => {
		const { input, output } = createMockStreams('1\n')
		const result = await promptSelect('Select template', choices, { input, output })
		expect(result).toBe('react-basic')
	})

	test('returns second option when 2 is entered', async () => {
		const { input, output } = createMockStreams('2\n')
		const result = await promptSelect('Select template', choices, { input, output })
		expect(result).toBe('react-sync')
	})
})
