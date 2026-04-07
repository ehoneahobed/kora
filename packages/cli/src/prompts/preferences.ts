import Conf from 'conf'
import type { AuthOption, DatabaseOption, DatabaseProviderOption, FrameworkOption } from '../commands/create/options'
import type { PackageManager } from '../types'

export interface CreatePreferences {
	framework: FrameworkOption
	tailwind: boolean
	sync: boolean
	db: DatabaseOption
	dbProvider: DatabaseProviderOption
	auth: AuthOption
	packageManager: PackageManager
}

const DEFAULT_PREFERENCES: CreatePreferences = {
	framework: 'react',
	tailwind: true,
	sync: true,
	db: 'sqlite',
	dbProvider: 'none',
	auth: 'none',
	packageManager: 'pnpm',
}

const PREFERENCES_KEY = 'create.defaults'

/**
 * Preference store for scaffold-time defaults in `create-kora-app`.
 */
export class PreferenceStore {
	private readonly store: Conf<{ [PREFERENCES_KEY]?: CreatePreferences }>

	public constructor() {
		this.store = new Conf<{ [PREFERENCES_KEY]?: CreatePreferences }>({
			projectName: 'korajs-cli',
		})
	}

	public getCreatePreferences(): CreatePreferences | null {
		return this.store.get(PREFERENCES_KEY) ?? null
	}

	public saveCreatePreferences(preferences: CreatePreferences): void {
		this.store.set(PREFERENCES_KEY, preferences)
	}

	public clearCreatePreferences(): void {
		this.store.delete(PREFERENCES_KEY)
	}
}

/**
 * Gets preferences from storage or returns defaults when not available.
 */
export function getCreatePreferencesOrDefault(store: PreferenceStore): CreatePreferences {
	return store.getCreatePreferences() ?? DEFAULT_PREFERENCES
}

export function getDefaultCreatePreferences(): CreatePreferences {
	return { ...DEFAULT_PREFERENCES }
}
