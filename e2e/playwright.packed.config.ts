import { defineConfig } from '@playwright/test'

/**
 * Browser scenarios on apps scaffolded and installed from the PACKED tarballs, beyond the
 * offline-readiness suite (`playwright.offline.config.ts`): auth-bound database namespacing with
 * an offline write, a refresh and a reconnect, and the worker and WASM loading from a non-root
 * base path. The release matrix runs it (`scripts/release/packed-matrix`, check `browser-app`)
 * with `KORA_PACKED_DIR`, `KORA_PACKED_EXACT=1` and `KORA_OFFLINE_CREATE_ENTRY` set; without
 * them it packs the workspace and scaffolds with the workspace CLI build, like the offline suite.
 *
 *   pnpm --filter kora-e2e test:packed
 */
export default defineConfig({
	testDir: './packed',
	testMatch: /.*\.spec\.ts/,
	fullyParallel: false,
	workers: 1,
	timeout: 15 * 60_000,
	retries: 0,
	reporter: [['list']],
})
