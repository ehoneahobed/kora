interface DevtoolsLike {
	panels: {
		create(
			title: string,
			iconPath: string,
			pagePath: string,
			callback: () => void,
		): void
	}
}

const devtools = (globalThis as { chrome?: { devtools?: DevtoolsLike } }).chrome?.devtools

if (devtools?.panels) {
	devtools.panels.create('Kora', '', 'devtools-page.html', () => {})
}
