import { promptConfirm, promptSelect, promptText } from '../utils/prompt'

export interface SelectOption<T extends string> {
	label: string
	value: T
}

export interface PromptClient {
	text(message: string, defaultValue?: string): Promise<string>
	select<T extends string>(message: string, options: readonly SelectOption<T>[]): Promise<T>
	confirm(message: string, defaultValue?: boolean): Promise<boolean>
}

/**
 * Prompt client backed by the current readline helpers.
 *
 * Phase 12 will introduce a richer prompt backend. This adapter keeps command
 * logic decoupled from the prompt implementation so we can migrate without
 * reshaping command behavior.
 */
export class ReadlinePromptClient implements PromptClient {
	public async text(message: string, defaultValue?: string): Promise<string> {
		return promptText(message, defaultValue)
	}

	public async select<T extends string>(
		message: string,
		options: readonly SelectOption<T>[],
	): Promise<T> {
		return promptSelect(message, options)
	}

	public async confirm(message: string, defaultValue = false): Promise<boolean> {
		return promptConfirm(message, defaultValue)
	}
}

/**
 * Returns the default prompt client for interactive CLI flows.
 */
export function createPromptClient(): PromptClient {
	return new ReadlinePromptClient()
}
