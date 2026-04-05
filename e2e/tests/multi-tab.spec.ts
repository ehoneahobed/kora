import { test, expect, type Page } from '@playwright/test'

test.describe('Multi-tab sync (same browser context)', () => {
  let pageA: Page
  let pageB: Page

  test.beforeEach(async ({ context }) => {
    pageA = await context.newPage()
    pageB = await context.newPage()

    await pageA.goto('/')
    await pageB.goto('/')

    await pageA.waitForSelector('[data-testid="heading"]')
    await pageB.waitForSelector('[data-testid="heading"]')
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
})
