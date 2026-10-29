import type { BrowserContext, BrowserType, LaunchOptions } from 'playwright-core'

/** Options for {@link openProfile}: the launch options of `launchPersistentContext`. */
export type ProfileOptions = Parameters<BrowserType['launchPersistentContext']>[1]

/**
 * A persistent browser profile: a user data directory plus the context currently open on it.
 * The origin's storage (OPFS, IndexedDB, Cache Storage, service workers, localStorage) lives in
 * the directory, so it survives {@link restartProfile}.
 */
export interface Profile {
	/** The browser type the profile was opened with (for example `chromium`). */
	readonly browserType: BrowserType
	/** The user data directory; keep it for the whole test and delete it afterwards. */
	readonly userDataDir: string
	/** The launch options reused on every restart. */
	readonly options: ProfileOptions
	/** The currently open context. Replaced by {@link restartProfile}. */
	context: BrowserContext
}

/**
 * Opens a persistent profile in `userDataDir`.
 *
 * @param browserType - Playwright's `chromium` (import it from `playwright-core`)
 * @param userDataDir - A directory to hold the profile, for example from `fs.mkdtemp`
 * @param options - Passed to `launchPersistentContext` (`headless`, `executablePath`, ...)
 * @returns The profile, with its first context open
 *
 * @example
 * ```typescript
 * const profile = await openProfile(chromium, dir, { executablePath: process.env.PW_CHROMIUM_PATH })
 * ```
 */
export async function openProfile(
	browserType: BrowserType,
	userDataDir: string,
	options: ProfileOptions = {},
): Promise<Profile> {
	const context = await browserType.launchPersistentContext(userDataDir, options)
	return { browserType, userDataDir, options, context }
}

/**
 * Restarts the browser on the same profile: closes the context (the browser process exits, as
 * when the user quits the browser) and reopens the same user data directory. Use it to prove
 * that what the app reported `ready` for survives a real restart, not only a reload.
 *
 * Pages from the old context are closed; open new ones on `profile.context`. The profile object
 * is updated in place and also returned.
 *
 * @param profile - A profile from {@link openProfile}
 * @param options - Replacement launch options for the new run (for example to go offline at
 *   launch through `offline: true`)
 * @returns The same profile, now holding the new context
 *
 * @example
 * ```typescript
 * await restartProfile(profile)
 * const page = await profile.context.newPage()
 * ```
 */
export async function restartProfile(
	profile: Profile,
	options?: Partial<LaunchOptions> & ProfileOptions,
): Promise<Profile> {
	await profile.context.close()
	const merged: ProfileOptions = { ...profile.options, ...options }
	profile.context = await profile.browserType.launchPersistentContext(profile.userDataDir, merged)
	return profile
}
