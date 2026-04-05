import { test, expect, type BrowserContext, type Page } from '@playwright/test'

test.describe('Offline convergence', () => {
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

    await pageA.waitForSelector('[data-testid="heading"]')
    await pageB.waitForSelector('[data-testid="heading"]')
  })

  test.afterEach(async () => {
    await contextA.close()
    await contextB.close()
  })

  test('offline mutations sync after reconnect', async () => {
    // Both connected initially — add a baseline item
    await pageA.fill('[data-testid="title-input"]', 'Baseline item')
    await pageA.click('[data-testid="add-button"]')

    // Wait for sync to B
    await expect(pageB.locator('[data-testid="todo-list"] li')).toHaveCount(1, { timeout: 10_000 })

    // Take tab A offline
    await contextA.setOffline(true)

    // Add 2 items while offline
    await pageA.fill('[data-testid="title-input"]', 'Offline item 1')
    await pageA.click('[data-testid="add-button"]')
    await pageA.fill('[data-testid="title-input"]', 'Offline item 2')
    await pageA.click('[data-testid="add-button"]')

    // Tab A should see 3 items locally
    await expect(pageA.locator('[data-testid="todo-list"] li')).toHaveCount(3)

    // Tab B should still see only 1 item
    await expect(pageB.locator('[data-testid="todo-list"] li')).toHaveCount(1)

    // Bring tab A back online
    await contextA.setOffline(false)

    // Tab B should eventually receive both offline items
    await expect(pageB.locator('[data-testid="todo-list"] li')).toHaveCount(3, { timeout: 15_000 })

    // Verify content
    const textB = await pageB.locator('[data-testid="todo-list"]').textContent()
    expect(textB).toContain('Offline item 1')
    expect(textB).toContain('Offline item 2')
  })
})
