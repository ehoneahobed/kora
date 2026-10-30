import { defineConfig } from '@playwright/test'

/**
 * The offline-readiness suite over the bundled CLI templates (A7). Separate from
 * `playwright.config.ts`: it needs no fixture app or dev servers, because each template is
 * scaffolded, built and served by the suite itself.
 *
 *   pnpm test:e2e:offline                                       all 13 templates
 *   KORA_OFFLINE_TEMPLATES=react-basic pnpm test:e2e:offline    a subset
 *
 * Run `pnpm build` first (the suite packs the built workspace packages).
 */
export default defineConfig({
	testDir: './offline',
	testMatch: /.*\.spec\.ts/,
	fullyParallel: false,
	workers: 1,
	// Scaffold + install + build run in a template's beforeAll, inside this budget.
	timeout: 15 * 60_000,
	retries: 0,
	reporter: [['list']],
})
