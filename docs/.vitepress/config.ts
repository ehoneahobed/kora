import { defineConfig } from 'vitepress'

export default defineConfig({
	title: 'Kora.js',
	description: 'Offline-first application framework',
	base: '/',
	head: [
		['link', { rel: 'icon', href: '/favicon.ico', sizes: '48x48' }],
		['link', { rel: 'icon', href: '/favicon-32x32.png', type: 'image/png', sizes: '32x32' }],
		['link', { rel: 'apple-touch-icon', href: '/favicon-180x180.png' }],
		['meta', { name: 'theme-color', content: '#e63323' }],
		['meta', { property: 'og:type', content: 'website' }],
		['meta', { property: 'og:site_name', content: 'Kora.js' }],
		['meta', { property: 'og:title', content: 'Kora.js: Offline-first application framework' }],
		[
			'meta',
			{
				property: 'og:description',
				content:
					'Build apps that work anywhere. Local-first storage, automatic conflict resolution, and sync with zero distributed-systems code.',
			},
		],
		['meta', { property: 'og:image', content: 'https://korajs.dev/kora-app-icon-512x512.png' }],
		['meta', { property: 'og:url', content: 'https://korajs.dev/' }],
		['meta', { name: 'twitter:card', content: 'summary' }],
	],
	sitemap: {
		hostname: 'https://korajs.dev',
	},
	themeConfig: {
		logo: {
			light: '/kora-emblem-color-transparent.png',
			dark: '/kora-emblem-white-transparent.png',
		},
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
