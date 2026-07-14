import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { defineConfig } from 'vitepress'

const SITE_URL = 'https://korajs.dev'

interface DocPage {
	path: string
	title: string
	description: string
	body: string
}

function collectMarkdown(dir: string, root: string, out: string[]): void {
	for (const entry of readdirSync(dir)) {
		if (entry === 'node_modules' || entry.startsWith('.') || entry === 'CHANGELOG.md') continue
		const full = join(dir, entry)
		if (statSync(full).isDirectory()) collectMarkdown(full, root, out)
		else if (entry.endsWith('.md')) out.push(relative(root, full))
	}
}

function parsePage(root: string, path: string): DocPage {
	const raw = readFileSync(join(root, path), 'utf-8')
	const fm = raw.match(/^---\n([\s\S]*?)\n---\n/)
	const title = fm?.[1].match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? path
	const description = fm?.[1].match(/^description:\s*"?(.+?)"?$/m)?.[1]?.trim() ?? ''
	const body = fm ? raw.slice(fm[0].length) : raw
	return { path, title, description, body }
}

/**
 * Emits machine-readable docs at build time so AI agents can consume the site:
 * raw .md copies of every page, an llms.txt index (llmstxt.org), and
 * llms-full.txt with the entire documentation in one file.
 */
function emitLlmsArtifacts(srcDir: string, outDir: string): void {
	const paths: string[] = []
	collectMarkdown(srcDir, srcDir, paths)
	paths.sort()

	const pages = paths.map((p) => parsePage(srcDir, p))
	for (const p of paths) {
		const dest = join(outDir, p)
		mkdirSync(dirname(dest), { recursive: true })
		copyFileSync(join(srcDir, p), dest)
	}

	const link = (p: DocPage): string => {
		const url = `${SITE_URL}/${p.path}`
		return p.description ? `- [${p.title}](${url}): ${p.description}` : `- [${p.title}](${url})`
	}
	const inSection = (prefix: string) => pages.filter((p) => p.path.startsWith(prefix))
	const rootPages = pages.filter((p) => !p.path.includes('/') && p.path !== 'index.md')

	const llms = [
		'# Kora.js',
		'',
		'> Kora.js is an offline-first JavaScript application framework. Apps store data locally in SQLite (WASM + OPFS in the browser, native SQLite in Node), get reactive queries and automatic conflict resolution, and sync across devices through a self-hosted server. Offline is the default state: every code path works without a network. Scaffold with `npx create-kora-app my-app`.',
		'',
		'Key facts: TypeScript-first with full type inference from schema to queries. Packages are published on npm under the @korajs scope plus the `korajs` meta-package. Conflict resolution is a three-tier merge engine (LWW/CRDT auto-merge, declarative constraints, custom resolvers). Sync uses hybrid logical clocks, version vectors, and a protobuf wire format, and resumes after disconnects. MIT licensed.',
		'',
		'The links below point directly at raw markdown files. The same pages rendered as HTML live at the same paths without the .md extension.',
		'',
		'## Start Here',
		'',
		...rootPages.map(link),
		'',
		'## Guides',
		'',
		...inSection('guide/').map(link),
		'',
		'## API Reference',
		'',
		...inSection('api/').map(link),
		'',
		'## Examples',
		'',
		...inSection('examples/').map(link),
		'',
		'## Optional',
		'',
		...inSection('releases/').map(link),
		'',
		`Full documentation in a single file: ${SITE_URL}/llms-full.txt`,
		'',
	].join('\n')
	writeFileSync(join(outDir, 'llms.txt'), llms)

	const full = pages
		.filter((p) => !p.path.startsWith('releases/'))
		.map((p) => `# ${p.title}\nSource: ${SITE_URL}/${p.path.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '')}\n\n${p.body.trim()}\n`)
		.join('\n---\n\n')
	writeFileSync(join(outDir, 'llms-full.txt'), full)
}


export default defineConfig({
	lang: 'en-US',
	title: 'Kora.js',
	titleTemplate: ':title | Kora.js',
	description:
		'Kora.js is an offline-first JavaScript framework. Local-first storage on SQLite, automatic conflict resolution, and multi-device sync with zero distributed-systems code.',
	base: '/',
	cleanUrls: true,
	head: [
		['link', { rel: 'icon', href: '/favicon.ico', sizes: '48x48' }],
		['link', { rel: 'icon', href: '/favicon-32x32.png', type: 'image/png', sizes: '32x32' }],
		['link', { rel: 'apple-touch-icon', href: '/favicon-180x180.png' }],
		['meta', { name: 'theme-color', content: '#e63323' }],
		['meta', { property: 'og:type', content: 'website' }],
		['meta', { property: 'og:site_name', content: 'Kora.js' }],
		[
			'meta',
			{
				property: 'og:description',
				content:
					'Build apps that work anywhere. Local-first storage, automatic conflict resolution, and sync with zero distributed-systems code.',
			},
		],
		['meta', { property: 'og:image', content: 'https://korajs.dev/og-image.png' }],
		['meta', { name: 'twitter:card', content: 'summary_large_image' }],
		['meta', { name: 'twitter:image', content: 'https://korajs.dev/og-image.png' }],
		[
			'script',
			{ type: 'application/ld+json' },
			JSON.stringify({
				'@context': 'https://schema.org',
				'@type': 'SoftwareApplication',
				name: 'Kora.js',
				applicationCategory: 'DeveloperApplication',
				operatingSystem: 'Any',
				description:
					'Offline-first JavaScript application framework with local SQLite storage, automatic conflict resolution, and multi-device sync.',
				url: 'https://korajs.dev',
				offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
				license: 'https://opensource.org/licenses/MIT',
			}),
		],
	],
	sitemap: {
		hostname: 'https://korajs.dev',
	},
	buildEnd(siteConfig) {
		emitLlmsArtifacts(siteConfig.srcDir, siteConfig.outDir)
	},
	transformPageData(pageData) {
		const path = pageData.relativePath.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '')
		const canonical = `https://korajs.dev/${path}`
		const title = pageData.title ? `${pageData.title} | Kora.js` : 'Kora.js'
		pageData.frontmatter.head = pageData.frontmatter.head ?? []
		pageData.frontmatter.head.push(
			['link', { rel: 'canonical', href: canonical }],
			['meta', { property: 'og:url', content: canonical }],
			['meta', { property: 'og:title', content: title }],
			['meta', { name: 'twitter:title', content: title }],
		)
		if (pageData.description) {
			pageData.frontmatter.head.push(['meta', { property: 'og:description', content: pageData.description }])
		}
	},
	themeConfig: {
		lastUpdated: true,
		logo: {
			light: '/kora-js-primary-transparent.png',
			dark: '/kora-js-white-transparent.png',
			alt: 'Kora.js',
		},
		siteTitle: false,
		nav: [
			{ text: 'Guide', link: '/getting-started' },
			{ text: 'API', link: '/api/' },
			{ text: 'Examples', link: '/examples/todo-app' },
			{ text: 'GitHub', link: 'https://github.com/ehoneahobed/kora' },
		],
		sidebar: [
			{
				text: 'Introduction',
				items: [{ text: 'Getting Started', link: '/getting-started' }],
			},
			{
				text: 'Guide',
				items: [
					{ text: 'Deployment', link: '/guide/deployment' },
					{ text: 'Schema Design', link: '/guide/schema-design' },
					{ text: 'React Hooks', link: '/guide/react-hooks' },
					{ text: 'Offline Patterns', link: '/guide/offline-patterns' },
					{ text: 'Conflict Resolution', link: '/guide/conflict-resolution' },
					{ text: 'Sync Configuration', link: '/guide/sync-configuration' },
					{ text: 'Storage Configuration', link: '/guide/storage-configuration' },
					{ text: 'Backup and Restore', link: '/guide/backup-restore' },
					{ text: 'Authentication', link: '/guide/authentication' },
					{ text: 'State Machines', link: '/guide/state-machines' },
					{ text: 'Sync Encryption', link: '/guide/sync-encryption' },
					{ text: 'Presence & Awareness', link: '/guide/presence' },
					{ text: 'Common Patterns', link: '/guide/common-patterns' },
					{ text: 'Testing', link: '/guide/testing' },
					{ text: 'Tauri Desktop Apps', link: '/guide/tauri-desktop' },
					{ text: 'DevTools', link: '/guide/devtools' },
				],
			},
			{
				text: 'API Reference',
				items: [
					{ text: 'Overview', link: '/api/' },
					{ text: 'Core', link: '/api/core' },
					{ text: 'Store', link: '/api/store' },
					{ text: 'Merge', link: '/api/merge' },
					{ text: 'Sync', link: '/api/sync' },
					{ text: 'Server', link: '/api/server' },
					{ text: 'Auth', link: '/api/auth' },
					{ text: 'React', link: '/api/react' },
					{ text: 'Vue', link: '/api/vue' },
					{ text: 'Svelte', link: '/api/svelte' },
					{ text: 'DevTools', link: '/api/devtools' },
					{ text: 'Test', link: '/api/test' },
					{ text: 'CLI', link: '/api/cli' },
				],
			},
			{
				text: 'Examples',
				items: [
					{ text: 'Todo App', link: '/examples/todo-app' },
					{ text: 'Collaborative Notes', link: '/examples/collaborative-notes' },
				],
			},
		],
		socialLinks: [{ icon: 'github', link: 'https://github.com/ehoneahobed/kora' }],
		search: {
			provider: 'local',
		},
	},
})
