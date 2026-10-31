import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from '@playwright/test'

// Each run scaffolds into a directory of its own. A fixed directory made a run that was killed
// halfway (or one started while another still ran) fail every template at once with
// "already exists" before a single test body ran. The packed tarballs stay shared: they are
// keyed on the workspace's modification times. Set KORA_OFFLINE_APPS_DIR to choose the
// directory (with KORA_OFFLINE_REUSE=1 to rerun against apps a previous run built), and
// KORA_OFFLINE_KEEP=1 to keep a run's apps for inspection.
process.env.KORA_OFFLINE_APPS_DIR ??= join(
	tmpdir(),
	'kora-offline-suite',
	`apps-${Date.now()}-${process.pid}`,
)

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
	globalTeardown: './offline/global-teardown.ts',
})
