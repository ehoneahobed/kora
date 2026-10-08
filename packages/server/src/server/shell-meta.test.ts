import { describe, expect, test } from 'vitest'
import { applyShellMeta, metaExcerpt } from './shell-meta'

const SHELL = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>KoraForms: build forms that work anywhere</title>
    <meta name="description" content="Generic description" />
    <meta property="og:title" content="KoraForms" />
    <meta property="og:description" content="Generic" />
    <meta property="og:image" content="https://forms.example/og.png" />
    <meta name="twitter:title" content="KoraForms" />
    <link rel="canonical" href="https://forms.example/" />
  </head>
  <body><div id="root"></div></body>
</html>`

function count(html: string, needle: string): number {
	return html.split(needle).length - 1
}

describe('applyShellMeta', () => {
	test('replaces title, description and their Open Graph and Twitter twins, once each', () => {
		const out = applyShellMeta(SHELL, {
			title: 'Field survey',
			description: 'Tell us about the pump.',
		})
		expect(out).toContain('<title>Field survey</title>')
		expect(out).toContain('<meta name="description" content="Tell us about the pump." />')
		expect(out).toContain('<meta property="og:title" content="Field survey" />')
		expect(out).toContain('<meta name="twitter:description" content="Tell us about the pump." />')
		expect(count(out, 'property="og:title"')).toBe(1)
		expect(count(out, 'name="description"')).toBe(1)
		expect(out).not.toContain('Generic')
		// Untouched tags stay.
		expect(out).toContain('<meta property="og:image" content="https://forms.example/og.png" />')
		expect(out.indexOf('og:title')).toBeLessThan(out.indexOf('</head>'))
	})

	test('escapes user text so it cannot inject markup', () => {
		const out = applyShellMeta(SHELL, {
			title: '</title><script>alert(1)</script>',
			description: '"><script>alert(2)</script>',
		})
		expect(out).not.toContain('<script>')
		expect(out).toContain('<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>')
		expect(out).toContain('content="&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;"')
	})

	test('a regex-special title or $ in values is written literally', () => {
		const out = applyShellMeta(SHELL, { title: 'Price $1 & $& (a+b)?' })
		expect(out).toContain('<title>Price $1 &amp; $&amp; (a+b)?</title>')
	})

	test('url sets og:url and replaces the canonical link; image sets both image tags', () => {
		const out = applyShellMeta(SHELL, {
			url: 'https://forms.example/f/survey',
			image: 'https://cdn.example/a.png',
			imageAlt: 'A pump',
		})
		expect(count(out, 'rel="canonical"')).toBe(1)
		expect(out).toContain('<link rel="canonical" href="https://forms.example/f/survey" />')
		expect(out).toContain('<meta property="og:url" content="https://forms.example/f/survey" />')
		expect(out).toContain('<meta name="twitter:image" content="https://cdn.example/a.png" />')
		expect(out).toContain('<meta property="og:image:alt" content="A pump" />')
		expect(count(out, 'property="og:image"')).toBe(1)
	})

	test('explicit tags win over derived ones; robots and type are set', () => {
		const out = applyShellMeta(SHELL, {
			title: 'Derived',
			robots: 'noindex',
			type: 'article',
			tags: [{ property: 'og:title', content: 'Explicit' }],
		})
		expect(out).toContain('<meta property="og:title" content="Explicit" />')
		expect(out).not.toContain('content="Derived" />\n    <meta property="og:title"')
		expect(count(out, 'property="og:title"')).toBe(1)
		expect(out).toContain('<meta name="robots" content="noindex" />')
		expect(out).toContain('<meta property="og:type" content="article" />')
	})

	test('a shell without a title or head still gets the tags', () => {
		expect(applyShellMeta('<html><head></head><body></body></html>', { title: 'T' })).toContain(
			'<title>T</title>',
		)
		expect(applyShellMeta('<body>x</body>', { description: 'D' })).toContain('content="D"')
	})

	test('empty meta leaves the document unchanged', () => {
		expect(applyShellMeta(SHELL, {})).toBe(SHELL)
	})

	test('very long values are clamped', () => {
		const out = applyShellMeta(SHELL, { description: 'word '.repeat(1000) })
		const content = out.match(/name="description" content="([^"]*)"/)?.[1] ?? ''
		expect(content.length).toBeLessThanOrEqual(1000)
	})
})

describe('metaExcerpt', () => {
	test('collapses whitespace and cuts at a word with an ellipsis', () => {
		expect(metaExcerpt('  Hello\n\n  world  ')).toBe('Hello world')
		const text = 'The quick brown fox jumps over the lazy dog. '.repeat(10)
		const cut = metaExcerpt(text, 50)
		expect(cut.length).toBeLessThanOrEqual(50)
		expect(cut.endsWith('…')).toBe(true)
		expect(cut).not.toMatch(/\s…$/)
	})
})
