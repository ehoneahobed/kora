import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Creates a temporary directory for tests. Returns path and cleanup function. */
export async function createTempDir(): Promise<{ path: string; cleanup: () => Promise<void> }> {
	const path = await mkdtemp(join(tmpdir(), 'kora-cli-test-'))
	return {
		path,
		async cleanup(): Promise<void> {
			await rm(path, { recursive: true, force: true })
		},
	}
}
