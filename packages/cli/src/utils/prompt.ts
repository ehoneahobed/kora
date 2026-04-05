import { type Interface as ReadlineInterface, createInterface } from 'node:readline'

export interface PromptOptions {
	/** Input stream (defaults to process.stdin) */
	input?: NodeJS.ReadableStream
	/** Output stream (defaults to process.stdout) */
	output?: NodeJS.WritableStream
}

/**
 * Prompts the user for text input.
 *
 * @param message - The prompt message to display
 * @param defaultValue - Optional default value shown in brackets
 * @param options - Optional input/output streams for testing
 */
export function promptText(
	message: string,
	defaultValue?: string,
	options?: PromptOptions,
): Promise<string> {
	return new Promise((resolve) => {
		const rl = createReadline(options)
		const suffix = defaultValue !== undefined ? ` (${defaultValue})` : ''
		rl.question(`  ? ${message}${suffix}: `, (answer) => {
			rl.close()
			const trimmed = answer.trim()
			resolve(trimmed || defaultValue || '')
		})
	})
}

/**
 * Prompts the user to select from a numbered list of options.
 *
 * @param message - The prompt message to display
 * @param choices - Array of { label, value } options
 * @param options - Optional input/output streams for testing
 */
export function promptSelect<T extends string>(
	message: string,
	choices: readonly { label: string; value: T }[],
	options?: PromptOptions,
): Promise<T> {
	return new Promise((resolve) => {
		const rl = createReadline(options)
		const out = options?.output ?? process.stdout

		out.write(`  ? ${message}\n`)
		for (let i = 0; i < choices.length; i++) {
			const choice = choices[i]
			if (choice) {
				out.write(`    ${i + 1}) ${choice.label}\n`)
			}
		}

		const ask = (): void => {
			rl.question('  > ', (answer) => {
				const index = Number.parseInt(answer.trim(), 10) - 1
				const selected = choices[index]
				if (selected) {
					rl.close()
					resolve(selected.value)
				} else {
					out.write(`  Please enter a number between 1 and ${choices.length}\n`)
					ask()
				}
			})
		}

		ask()
	})
}

/**
 * Prompts the user with a yes/no confirmation.
 *
 * @param message - The prompt message to display
 * @param defaultValue - Default when input is empty (true => yes)
 * @param options - Optional input/output streams for testing
 */
export function promptConfirm(
	message: string,
	defaultValue = false,
	options?: PromptOptions,
): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = createReadline(options)
		const suffix = defaultValue ? 'Y/n' : 'y/N'

		const ask = (): void => {
			rl.question(`  ? ${message} (${suffix}): `, (answer) => {
				const normalized = answer.trim().toLowerCase()
				if (normalized.length === 0) {
					rl.close()
					resolve(defaultValue)
					return
				}

				if (normalized === 'y' || normalized === 'yes') {
					rl.close()
					resolve(true)
					return
				}

				if (normalized === 'n' || normalized === 'no') {
					rl.close()
					resolve(false)
					return
				}

				(options?.output ?? process.stdout).write('  Please answer with y or n\n')
				ask()
			})
		}

		ask()
	})
}

function createReadline(options?: PromptOptions): ReadlineInterface {
	return createInterface({
		input: options?.input ?? process.stdin,
		output: options?.output ?? process.stdout,
	})
}
