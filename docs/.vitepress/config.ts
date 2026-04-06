import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Kora.js',
  description: 'Offline-first application framework',
  base: '/kora/',
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/getting-started' },
      { text: 'API', link: '/api/' },
      { text: 'Examples', link: '/examples/todo-app' },
      { text: 'GitHub', link: 'https://github.com/ehoneahobed/kora' },
    ],
    sidebar: [
      {
        text: 'Introduction',
        items: [
          { text: 'Getting Started', link: '/getting-started' },
        ],
      },
      {
        text: 'Guide',
        items: [
          { text: 'Schema Design', link: '/guide/schema-design' },
          { text: 'Storage Configuration', link: '/guide/storage-configuration' },
          { text: 'Offline Patterns', link: '/guide/offline-patterns' },
          { text: 'Conflict Resolution', link: '/guide/conflict-resolution' },
          { text: 'Sync Configuration', link: '/guide/sync-configuration' },
          { text: 'React Hooks', link: '/guide/react-hooks' },
          { text: 'DevTools', link: '/guide/devtools' },
          { text: 'Deployment', link: '/guide/deployment' },
        ],
      },
      {
        text: 'API Reference',
        items: [
          { text: 'Overview', link: '/api/' },
          { text: 'Core', link: '/api/core' },
          { text: 'Store', link: '/api/store' },
          { text: 'Server', link: '/api/server' },
          { text: 'React', link: '/api/react' },
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
    socialLinks: [
      { icon: 'github', link: 'https://github.com/ehoneahobed/kora' },
    ],
    search: {
      provider: 'local',
    },
  },
})
