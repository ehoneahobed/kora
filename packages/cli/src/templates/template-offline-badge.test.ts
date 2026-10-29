import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const templatesDir = resolve(here, '../../templates')
const templates = readdirSync(templatesDir)

const framework = (template: string): 'react' | 'vue' | 'svelte' =>
	template.startsWith('vue') ? 'vue' : template.startsWith('svelte') ? 'svelte' : 'react'

const badgeFile = {
	react: 'OfflineBadge.tsx',
	vue: 'OfflineBadge.vue',
	svelte: 'OfflineBadge.svelte',
}
const appFile = { react: 'App.tsx', vue: 'App.vue', svelte: 'App.svelte' }

describe('<OfflineBadge /> in every template (offline-readiness design, section 7)', () => {
	test('covers all 13 templates, tauri-react included', () => {
		expect(templates).toHaveLength(13)
		expect(templates).toContain('tauri-react')
	})

	test.each(templates)('%s ships the badge and renders it from App', (template) => {
		const fw = framework(template)
		const src = join(templatesDir, template, 'src')
		const badge = readFileSync(join(src, badgeFile[fw]), 'utf8')

		// Reads the status through the matching framework package's hook.
		expect(badge).toContain(`import { useOfflineReady } from '@korajs/${fw}'`)
		// Not rendered in `vite dev`.
		expect(badge).toContain('import.meta.env.DEV')
		// Copy from the design.
		expect(badge).toContain('Available offline')
		expect(badge).toContain('may be cleared if unused')
		expect(badge).toContain('Preparing offline copy...')
		expect(badge).toContain('Not available offline yet')
		expect(badge).toContain('storage.persisted === false')
		// First reason as the tooltip.
		expect(badge).toMatch(
			/title=\{\$?offline(\.value)?\.reasons\[0\]\}|:title="offline\.reasons\[0\]"/,
		)

		const app = readFileSync(join(src, appFile[fw]), 'utf8')
		expect(app).toMatch(
			/import OfflineBadge from '\.\/OfflineBadge\.(vue|svelte)'|import \{ OfflineBadge \} from '\.\/OfflineBadge'/,
		)
		expect(app).toContain('<OfflineBadge />')
	})

	test.each(templates)('%s declares the dependency the badge imports', (template) => {
		const manifest = readFileSync(join(templatesDir, template, 'package.json.hbs'), 'utf8')
		expect(manifest).toContain(`"@korajs/${framework(template)}"`)
	})

	test.each(templates.filter((t) => !t.startsWith('tauri') && !t.includes('tailwind')))(
		'%s styles the badge in its stylesheet',
		(template) => {
			const css = readFileSync(join(templatesDir, template, 'src', 'index.css'), 'utf8')
			for (const selector of [
				'.offline-badge',
				'.offline-dot.ready',
				'.offline-dot.preparing',
				'.offline-dot.not-ready',
			]) {
				expect(css, `${template}: ${selector}`).toContain(selector)
			}
		},
	)
})
