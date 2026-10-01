// NEW-DX-3 repro: a Kora app served by createProductionServer cannot be reopened offline (no service worker / app-shell caching).
// Expected (correct) behaviour: offline reload renders the app shell. Today: net::ERR_INTERNET_DISCONNECTED.
// Run: mkdir -p /tmp/swtest/static/assets, add index.html + assets/app-abc123.js, then: node this-file
import { createProductionServer, MemoryServerStore } from '/home/claude/ehoneahobed/kora/packages/server/dist/index.js'
import { createRequire } from 'node:module'
const require = createRequire('/home/claude/ehoneahobed/kora/e2e/package.json')
const { chromium } = require('@playwright/test')
const server = createProductionServer({ store: new MemoryServerStore(), staticDir: '/tmp/swtest/static', port: 4791 })
const url = await server.start()
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
const ctx = await browser.newContext(); const page = await ctx.newPage()
await page.goto('http://localhost:4791/'); console.log('online load:', await page.textContent('#t'), '| title:', await page.title())
await ctx.setOffline(true)
let res
try { await page.reload({ timeout: 8000 }); res = await page.textContent('body') } catch (e) { res = 'RELOAD FAILED: ' + e.message.split('\n')[0] }
console.log('offline reload:', String(res).slice(0,120))
await browser.close(); await server.stop?.(); process.exit(0)
