import { type Page, expect, test } from '@playwright/test'
import { openFixtureInTabs } from './helpers'

/**
 * Same-origin multi-tab without sync: leader election + shared SQLite (OPFS).
 * Requires VITE_E2E_LOCAL=true (see playwright project local-multi-tab).
 */
test.describe('Multi-tab local storage (no sync)', () => {
	let pageA: Page
	let pageB: Page

	test.beforeEach(async ({ context }) => {
		pageA = await context.newPage()
		pageB = await context.newPage()

		await openFixtureInTabs(pageA, pageB, { sharedDatabase: true })
	})

	test('insert in tab A is visible in tab B without network', async () => {
		await expect(pageA.locator('[data-testid="sync-status"]')).toContainText('offline')

		await pageA.fill('[data-testid="title-input"]', 'Local leader tab write')
		await pageA.click('[data-testid="add-button"]')

		await expect(pageA.locator('[data-testid="todo-list"] li')).toHaveCount(1, {
			timeout: 5000,
		})

		await expect(pageB.locator('[data-testid="todo-list"] li')).toHaveCount(1, {
			timeout: 5000,
		})
		await expect(pageB.locator('[data-testid="todo-list"] li').first()).toContainText(
			'Local leader tab write',
		)
	})

	test('concurrent inserts in both tabs share one database', async () => {
		await Promise.all([
			(async () => {
				await pageA.fill('[data-testid="title-input"]', 'Local A')
				await pageA.click('[data-testid="add-button"]')
			})(),
			(async () => {
				await pageB.fill('[data-testid="title-input"]', 'Local B')
				await pageB.click('[data-testid="add-button"]')
			})(),
		])

		await expect(pageA.locator('[data-testid="todo-list"] li')).toHaveCount(2, {
			timeout: 8000,
		})
		await expect(pageB.locator('[data-testid="todo-list"] li')).toHaveCount(2, {
			timeout: 8000,
		})

		const titlesA = await pageA.locator('[data-testid="todo-list"] li span').allTextContents()
		const titlesB = await pageB.locator('[data-testid="todo-list"] li span').allTextContents()
		expect(titlesA.sort()).toEqual(titlesB.sort())
	})

	test('local data survives reload through the durable worker path', async () => {
		await pageA.fill('[data-testid="title-input"]', 'Survives reload')
		await pageA.click('[data-testid="add-button"]')
		await expect(pageA.locator('[data-testid="todo-list"] li')).toHaveCount(1, {
			timeout: 5000,
		})

		await pageA.reload({ waitUntil: 'domcontentloaded' })
		await expect(pageA.getByTestId('sync-status')).toBeAttached({ timeout: 120_000 })
		await expect(pageA.locator('[data-testid="todo-list"] li')).toHaveCount(1, {
			timeout: 10_000,
		})
		await expect(pageA.locator('[data-testid="todo-list"] li').first()).toContainText(
			'Survives reload',
		)
	})

	test('follower is promoted after leader closes and keeps durable data', async () => {
		await pageA.fill('[data-testid="title-input"]', 'Before leader close')
		await pageA.click('[data-testid="add-button"]')
		await expect(pageB.locator('[data-testid="todo-list"] li')).toHaveCount(1, {
			timeout: 10_000,
		})

		await pageA.close()
		await pageB.fill('[data-testid="title-input"]', 'After promotion')
		await pageB.click('[data-testid="add-button"]')
		await expect(pageB.locator('[data-testid="todo-list"] li')).toHaveCount(2, {
			timeout: 20_000,
		})

		await pageB.reload({ waitUntil: 'domcontentloaded' })
		await expect(pageB.getByTestId('sync-status')).toBeAttached({ timeout: 120_000 })
		await expect(pageB.locator('[data-testid="todo-list"] li')).toHaveCount(2, {
			timeout: 20_000,
		})
		const titles = await pageB.locator('[data-testid="todo-list"] li span').allTextContents()
		expect(titles.sort()).toEqual(['After promotion', 'Before leader close'])
	})
})
