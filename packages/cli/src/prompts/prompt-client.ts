import {
	cancel as clackCancel,
	confirm as clackConfirm,
	intro as clackIntro,
	isCancel as clackIsCancel,
	outro as clackOutro,
	select as clackSelect,
	text as clackText,
} from '@clack/prompts'
import { promptConfirm, promptSelect, promptText } from '../utils/prompt'

export interface SelectOption<T extends string> {
	label: string
	value: T
	hint?: string
	disabled?: boolean
}

type ClackSelectOption<T extends string> = {
	value: T
	label?: string
	hint?: string
	disabled?: boolean
}

export interface PromptClient {
	text(message: string, defaultValue?: string): Promise<string>
	select<T extends string>(message: string, options: readonly SelectOption<T>[]): Promise<T>
	confirm(message: string, defaultValue?: boolean): Promise<boolean>
	intro(message: string): void
	outro(message: string): void
}

export class PromptCancelledError extends Error {
	public constructor(message = 'Prompt cancelled by user') {
		super(message)
		this.name = 'PromptCancelledError'
	}
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
		return promptSelect(
			message,
			options
				.filter((option) => option.disabled !== true)
				.map((option) => ({ label: option.label, value: option.value })),
		)
	}

	public async confirm(message: string, defaultValue = false): Promise<boolean> {
		return promptConfirm(message, defaultValue)
	}

	public intro(message: string): void {
		// The readline backend does not provide intro/outro framing.
		// Keep no-op semantics for compatibility.
		void message
	}

	public outro(message: string): void {
		// The readline backend does not provide intro/outro framing.
		// Keep no-op semantics for compatibility.
		void message
	}
}

/**
 * Returns the default prompt client for interactive CLI flows.
 */
export function createPromptClient(): PromptClient {
	const canUseInteractiveClack = typeof process !== 'undefined' && process.stdin.isTTY && process.stdout.isTTY
	if (canUseInteractiveClack) {
		return new ClackPromptClient()
	}
	return new ReadlinePromptClient()
}

/**
 * Prompt client backed by @clack/prompts for richer interactive UX.
 * Falls back to readline in non-interactive contexts.
 */
export class ClackPromptClient implements PromptClient {
	public async text(message: string, defaultValue?: string): Promise<string> {
		const result = await clackText({
			message,
			placeholder: defaultValue,
			defaultValue,
		})
		if (clackIsCancel(result)) {
			clackCancel('Operation cancelled.')
			throw new PromptCancelledError()
		}
		const value = result.trim()
		if (value.length > 0) return value
		return defaultValue ?? ''
	}

	public async select<T extends string>(
		message: string,
		options: readonly SelectOption<T>[],
	): Promise<T> {
		const mappedOptions: ClackSelectOption<T>[] = options.map((option) => ({
			label: option.label,
			value: option.value,
			hint: option.hint,
			disabled: option.disabled,
		}))
		const result = await clackSelect({
			message,
			options: mappedOptions as unknown as Parameters<typeof clackSelect>[0]['options'],
		})
		if (clackIsCancel(result)) {
			clackCancel('Operation cancelled.')
			throw new PromptCancelledError()
		}
		return result as T
	}

	public async confirm(message: string, defaultValue = false): Promise<boolean> {
		const result = await clackConfirm({
			message,
			initialValue: defaultValue,
		})
		if (clackIsCancel(result)) {
			clackCancel('Operation cancelled.')
			throw new PromptCancelledError()
		}
		return result
	}

	public intro(message: string): void {
		clackIntro(message)
	}

	public outro(message: string): void {
		clackOutro(message)
	}
}
