import { describe, expect, test } from 'vitest'
import type { SelectOption } from '../../prompts/prompt-client'
import type { CreatePreferences } from '../../prompts/preferences'
import { resolveCreatePreferencesFlow } from './preferences-flow'

class MockPreferenceStore {
	private preferences: CreatePreferences | null

	public constructor(preferences: CreatePreferences | null) {
		this.preferences = preferences
	}

	public getCreatePreferences(): CreatePreferences | null {
		return this.preferences
	}

	public saveCreatePreferences(preferences: CreatePreferences): void {
		this.preferences = preferences
	}

	public clearCreatePreferences(): void {
		this.preferences = null
	}
}

class MockPromptClient {
	private readonly selectAnswers: string[]
	private readonly confirmAnswers: boolean[]

	public constructor(config?: { selectAnswers?: string[]; confirmAnswers?: boolean[] }) {
		this.selectAnswers = [...(config?.selectAnswers ?? [])]
		this.confirmAnswers = [...(config?.confirmAnswers ?? [])]
	}

	public async text(_message: string, defaultValue?: string): Promise<string> {
		return defaultValue ?? ''
	}

	public async select<T extends string>(
		_message: string,
		options: readonly SelectOption<T>[],
	): Promise<T> {
		const answer = this.selectAnswers.shift()
		if (answer !== undefined) {
			return answer as T
		}
		const firstEnabled = options.find((option) => option.disabled !== true)
		if (!firstEnabled) {
			throw new Error('No enabled options available in mock prompt client.')
		}
		return firstEnabled.value
	}

	public async confirm(_message: string, defaultValue?: boolean): Promise<boolean> {
		const answer = this.confirmAnswers.shift()
		return answer ?? defaultValue ?? false
	}

	public intro(_message: string): void {}

	public outro(_message: string): void {}
}

function ensureTtyForPreferencePrompt(): () => void {
	const originalStdin = process.stdin.isTTY
	const originalStdout = process.stdout.isTTY
	Object.defineProperty(process.stdin, 'isTTY', {
		value: true,
		configurable: true,
	})
	Object.defineProperty(process.stdout, 'isTTY', {
		value: true,
		configurable: true,
	})
	return () => {
		Object.defineProperty(process.stdin, 'isTTY', {
			value: originalStdin,
			configurable: true,
		})
		Object.defineProperty(process.stdout, 'isTTY', {
			value: originalStdout,
			configurable: true,
		})
	}
}

describe('resolveCreatePreferencesFlow', () => {
	test('uses hard defaults for --yes flow', async () => {
		const store = new MockPreferenceStore({
			framework: 'react',
			tailwind: false,
			sync: false,
			db: 'none',
			dbProvider: 'none',
			auth: 'none',
			packageManager: 'npm',
		})

		const result = await resolveCreatePreferencesFlow({
			flags: { useDefaults: true },
			prompts: new MockPromptClient(),
			store,
		})

		expect(result.framework).toBe('react')
		expect(result.tailwind).toBe(true)
		expect(result.sync).toBe(true)
		expect(result.db).toBe('sqlite')
		expect(result.template).toBe('react-tailwind-sync')
		expect(result.usedStoredPreferences).toBe(false)
	})

	test('reuses stored preferences when user chooses reuse', async () => {
		const restoreTty = ensureTtyForPreferencePrompt()
		try {
			const store = new MockPreferenceStore({
				framework: 'react',
				tailwind: false,
				sync: true,
				db: 'postgres',
				dbProvider: 'neon',
				auth: 'none',
				packageManager: 'pnpm',
			})

			const result = await resolveCreatePreferencesFlow({
				flags: { useDefaults: false },
				prompts: new MockPromptClient({ selectAnswers: ['reuse'] }),
				store,
			})

			expect(result.usedStoredPreferences).toBe(true)
			expect(result.tailwind).toBe(false)
			expect(result.db).toBe('postgres')
			expect(result.dbProvider).toBe('neon')
			expect(result.template).toBe('react-sync')
		} finally {
			restoreTty()
		}
	})

	test('explicit flags override stored values', async () => {
		const store = new MockPreferenceStore({
			framework: 'react',
			tailwind: true,
			sync: true,
			db: 'postgres',
			dbProvider: 'supabase',
			auth: 'none',
			packageManager: 'pnpm',
		})

		const result = await resolveCreatePreferencesFlow({
			flags: {
				useDefaults: false,
				db: 'none',
				tailwind: false,
				sync: false,
			},
			prompts: new MockPromptClient(),
			store,
		})

		expect(result.db).toBe('none')
		expect(result.sync).toBe(false)
		expect(result.tailwind).toBe(false)
		expect(result.template).toBe('react-basic')
	})

})
