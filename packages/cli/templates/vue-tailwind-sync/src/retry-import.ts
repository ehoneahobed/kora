/**
 * Loads a lazy chunk. A browser keeps the failure of an import for that URL, so importing it
 * again cannot succeed (a dropped request, a deploy in progress): the recovery is one page reload
 * (guarded, so a chunk that is really gone cannot loop), which fetches the chunk again. After
 * that reload, or without a page to reload, the failure is thrown and the caller reports it.
 * The same contract in the React, Vue and Svelte templates.
 */
export async function retryImport<T>(
	load: () => Promise<T>,
	page: {
		reload?: () => void
		storage?: Pick<Storage, 'getItem' | 'setItem'>
		now?: () => number
	} = {},
): Promise<T> {
	try {
		return await load()
	} catch (error) {
		const reload =
			page.reload ?? (typeof window !== 'undefined' ? () => window.location.reload() : null)
		const now = (page.now ?? Date.now)()
		try {
			const storage = page.storage ?? (typeof window !== 'undefined' ? window.sessionStorage : null)
			const key = 'kora:chunk-reload:auth'
			if (reload && storage && now - Number(storage.getItem(key) ?? '0') >= 30_000) {
				storage.setItem(key, String(now))
				reload()
				// The page is going away; the lazy component stays suspended until it does.
				return await new Promise<never>(() => {})
			}
		} catch {
			// No session storage: a reload could loop, so none is attempted.
		}
		throw error
	}
}
