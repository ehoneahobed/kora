/**
 * Loads a lazy chunk, trying again after a short wait when the request failed (a dropped
 * connection, a deploy in progress). A chunk that is still missing after the last try rejects, and
 * the caller reports it. The same contract in the React, Vue and Svelte templates.
 */
export async function retryImport<T>(load: () => Promise<T>, tries = 3): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await load()
		} catch (error) {
			if (attempt >= tries) throw error
			await new Promise((resolve) => setTimeout(resolve, attempt * 500))
		}
	}
}
