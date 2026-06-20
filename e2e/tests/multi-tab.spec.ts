import { type Page, expect, test } from '@playwright/test'
import { openFixtureInTabs } from './helpers'

test.describe('Multi-tab sync (same browser context)', () => {
	let pageA: Page
	let pageB: Page

	test.beforeEach(async ({ context }) => {
		pageA = await context.newPage()
		pageB = await context.newPage()

		await openFixtureInTabs(pageA, pageB)
	})

	test('insert in page A appears in page B via sync', async () => {
		await pageA.fill('[data-testid="title-input"]', 'Shared todo')
		await pageA.click('[data-testid="add-button"]')

		// Verify local
		await expect(pageA.locator('[data-testid="todo-list"] li')).toHaveCount(1)

		// Wait for sync to page B
		await expect(pageB.locator('[data-testid="todo-list"] li')).toHaveCount(1, { timeout: 10_000 })
		await expect(pageB.locator('[data-testid="todo-list"] li').first()).toContainText('Shared todo')
	})

	test('concurrent inserts in both tabs converge to the same todo set', async () => {
		await Promise.all([
			(async () => {
				await pageA.fill('[data-testid="title-input"]', 'Tab A todo')
				await pageA.click('[data-testid="add-button"]')
			})(),
			(async () => {
				await pageB.fill('[data-testid="title-input"]', 'Tab B todo')
				await pageB.click('[data-testid="add-button"]')
			})(),
		])

		await expect(pageA.locator('[data-testid="todo-list"] li')).toHaveCount(2, { timeout: 10_000 })
		await expect(pageB.locator('[data-testid="todo-list"] li')).toHaveCount(2, { timeout: 10_000 })

		const titlesA = await pageA.locator('[data-testid="todo-list"] li span').allTextContents()
		const titlesB = await pageB.locator('[data-testid="todo-list"] li span').allTextContents()
		expect(titlesA.sort()).toEqual(titlesB.sort())
		expect(titlesA).toEqual(expect.arrayContaining(['Tab A todo', 'Tab B todo']))
	})
})
