// biome-ignore lint/suspicious/noExplicitAny: Chrome extension API global has no type definitions without @types/chrome
declare const chrome: any

if (chrome?.devtools?.panels) {
	chrome.devtools.panels.create('Kora', '', 'devtools-page.html', () => {})
}
