import { test, expect, type BrowserContext, type Page } from '@playwright/test'

test.describe('CRUD Sync across two browser contexts', () => {
  let contextA: BrowserContext
  let contextB: BrowserContext
  let pageA: Page
  let pageB: Page

  test.beforeEach(async ({ browser }) => {
    contextA = await browser.newContext()
    contextB = await browser.newContext()
    pageA = await contextA.newPage()
    pageB = await contextB.newPage()

    await pageA.goto('/')
    await pageB.goto('/')

    // Wait for both apps to load
    await pageA.waitForSelector('[data-testid="heading"]')
    await pageB.waitForSelector('[data-testid="heading"]')
  })

  test.afterEach(async () => {
    await contextA.close()
    await contextB.close()
  })

  test('insert in tab A syncs to tab B', async () => {
    // Add a todo in tab A
    await pageA.fill('[data-testid="title-input"]', 'Buy groceries')
    await pageA.click('[data-testid="add-button"]')

    // Verify it appears locally in tab A
    await expect(pageA.locator('[data-testid="todo-list"] li')).toHaveCount(1)
    await expect(pageA.locator('[data-testid="todo-list"] li').first()).toContainText('Buy groceries')

    // Wait for it to appear in tab B via sync
    await expect(pageB.locator('[data-testid="todo-list"] li')).toHaveCount(1, { timeout: 10_000 })
    await expect(pageB.locator('[data-testid="todo-list"] li').first()).toContainText('Buy groceries')
  })

  test('update in tab A syncs to tab B', async () => {
    // Add a todo in tab A
    await pageA.fill('[data-testid="title-input"]', 'Read a book')
    await pageA.click('[data-testid="add-button"]')

    // Wait for sync to tab B
    await expect(pageB.locator('[data-testid="todo-list"] li')).toHaveCount(1, { timeout: 10_000 })

    // Toggle completed in tab A
    const checkbox = pageA.locator('[data-testid="todo-list"] li input[type="checkbox"]').first()
    await checkbox.check()

    // Wait for toggle to sync to tab B
    await expect(
      pageB.locator('[data-testid="todo-list"] li input[type="checkbox"]').first()
    ).toBeChecked({ timeout: 10_000 })
  })

  test('delete in tab A syncs to tab B', async () => {
    // Add a todo in tab A
    await pageA.fill('[data-testid="title-input"]', 'Item to delete')
    await pageA.click('[data-testid="add-button"]')

    // Wait for sync to tab B
    await expect(pageB.locator('[data-testid="todo-list"] li')).toHaveCount(1, { timeout: 10_000 })

    // Delete in tab A
    await pageA.locator('[data-testid="todo-list"] li button').first().click()

    // Verify removed locally
    await expect(pageA.locator('[data-testid="todo-list"] li')).toHaveCount(0)

    // Verify removed in tab B via sync
    await expect(pageB.locator('[data-testid="todo-list"] li')).toHaveCount(0, { timeout: 10_000 })
  })
})
