/* eslint-disable @typescript-eslint/no-explicit-any */
declare const chrome: any
/* eslint-enable @typescript-eslint/no-explicit-any */

if (chrome?.devtools?.panels) {
	chrome.devtools.panels.create('Kora', '', 'devtools-page.html', () => {})
}
