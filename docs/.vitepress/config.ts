import { defineConfig } from 'vitepress'

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
