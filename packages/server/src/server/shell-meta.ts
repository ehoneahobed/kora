/**
 * Per-URL `<head>` metadata for the app shell (`index.html`).
 *
 * Link previews (WhatsApp, Slack, iMessage, LinkedIn, X) and search engines read the
 * HTML the server sends; they do not run the app's JavaScript. A single-page app
 * therefore shows the same generic card for every URL unless the server writes the
 * page's own title and description into the shell before sending it.
 */

/** One `<meta>` tag: `name` (description, twitter:*) or `property` (og:*). */
export interface ShellMetaTag {
	name?: string
	property?: string
	content: string
}

/**
 * Metadata for one URL. Every field is optional; fields left out keep what the
 * build's `index.html` declares.
 */
export interface ShellMeta {
	/** `<title>`, and `og:title` / `twitter:title` unless `tags` sets them. */
	title?: string
	/** `<meta name="description">`, and `og:description` / `twitter:description`. */
	description?: string
	/** Canonical absolute URL: `og:url` and `<link rel="canonical">`. */
	url?: string
	/** Absolute image URL: `og:image` and `twitter:image`. */
	image?: string
	/** `og:image:alt` and `twitter:image:alt`. */
	imageAlt?: string
	/** `og:type`, for example `website` or `article`. */
	type?: string
	/** `og:site_name`. */
	siteName?: string
	/** `<meta name="robots">`, for example `noindex` for private pages. */
	robots?: string
	/** Further tags. A tag here replaces the shell's tag with the same name or property. */
	tags?: ShellMetaTag[]
}

/** Longest value written into a tag; longer values are cut at a word boundary. */
const MAX_VALUE_LENGTH = 1000

/**
 * Write `meta` into an HTML document's head. Values are escaped, so text taken from
 * user data (a form title, a document excerpt) cannot inject markup. A tag the shell
 * already declares with the same name or property is replaced, never duplicated.
 *
 * @param html - The shell document (the build's `index.html`)
 * @param meta - Metadata for the requested URL
 * @returns The document with the metadata applied
 */
export function applyShellMeta(html: string, meta: ShellMeta): string {
	const tags: ShellMetaTag[] = []
	const add = (tag: ShellMetaTag): void => {
		const key = tagKey(tag)
		if (key === null) return
		const existing = tags.findIndex((other) => tagKey(other) === key)
		if (existing >= 0) tags.splice(existing, 1)
		tags.push(tag)
	}
	if (meta.description !== undefined) {
		add({ name: 'description', content: meta.description })
		add({ property: 'og:description', content: meta.description })
		add({ name: 'twitter:description', content: meta.description })
	}
	if (meta.title !== undefined) {
		add({ property: 'og:title', content: meta.title })
		add({ name: 'twitter:title', content: meta.title })
	}
	if (meta.url !== undefined) add({ property: 'og:url', content: meta.url })
	if (meta.image !== undefined) {
		add({ property: 'og:image', content: meta.image })
		add({ name: 'twitter:image', content: meta.image })
	}
	if (meta.imageAlt !== undefined) {
		add({ property: 'og:image:alt', content: meta.imageAlt })
		add({ name: 'twitter:image:alt', content: meta.imageAlt })
	}
	if (meta.type !== undefined) add({ property: 'og:type', content: meta.type })
	if (meta.siteName !== undefined) add({ property: 'og:site_name', content: meta.siteName })
	if (meta.robots !== undefined) add({ name: 'robots', content: meta.robots })
	// Explicit tags last: they win over the ones derived above.
	for (const tag of meta.tags ?? []) add(tag)

	let out = html
	if (meta.title !== undefined) out = replaceTitle(out, meta.title)
	for (const tag of tags) out = removeTag(out, tag)
	if (meta.url !== undefined) {
		out = out.replace(/<link\b[^>]*\brel\s*=\s*["']?canonical["']?[^>]*>\s*/gi, '')
	}
	const lines = tags.map(renderTag)
	if (meta.url !== undefined)
		lines.push(`<link rel="canonical" href="${escapeAttribute(meta.url)}" />`)
	return insertIntoHead(out, lines)
}

/** A short plain-text excerpt for a description: whitespace collapsed, cut at a word. */
export function metaExcerpt(text: string, maxLength = 160): string {
	const flat = text.replace(/\s+/g, ' ').trim()
	if (flat.length <= maxLength) return flat
	const cut = flat.slice(0, maxLength - 1)
	const space = cut.lastIndexOf(' ')
	return `${(space > maxLength * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

function tagKey(tag: ShellMetaTag): string | null {
	if (tag.property) return `property:${tag.property.toLowerCase()}`
	if (tag.name) return `name:${tag.name.toLowerCase()}`
	return null
}

function renderTag(tag: ShellMetaTag): string {
	const attribute = tag.property
		? `property="${escapeAttribute(tag.property)}"`
		: `name="${escapeAttribute(tag.name ?? '')}"`
	return `<meta ${attribute} content="${escapeAttribute(clamp(tag.content))}" />`
}

function removeTag(html: string, tag: ShellMetaTag): string {
	const attribute = tag.property ? 'property' : 'name'
	const value = escapeRegExp(tag.property ?? tag.name ?? '')
	const pattern = new RegExp(
		`<meta\\b[^>]*\\b${attribute}\\s*=\\s*["']?${value}["']?(?=[\\s/>])[^>]*>\\s*`,
		'gi',
	)
	return html.replace(pattern, '')
}

function replaceTitle(html: string, title: string): string {
	const rendered = `<title>${escapeText(clamp(title))}</title>`
	if (/<title\b[^>]*>[\s\S]*?<\/title>/i.test(html)) {
		return html.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, () => rendered)
	}
	return insertIntoHead(html, [rendered])
}

function insertIntoHead(html: string, lines: string[]): string {
	if (lines.length === 0) return html
	const block = `${lines.join('\n    ')}\n  `
	const close = html.search(/<\/head\s*>/i)
	if (close >= 0) return `${html.slice(0, close)}  ${block}${html.slice(close)}`
	const open = html.match(/<head\b[^>]*>/i)
	if (open?.index !== undefined) {
		const at = open.index + open[0].length
		return `${html.slice(0, at)}\n    ${block}${html.slice(at)}`
	}
	return `${block}${html}`
}

function clamp(value: string): string {
	return value.length > MAX_VALUE_LENGTH ? metaExcerpt(value, MAX_VALUE_LENGTH) : value
}

function escapeText(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttribute(value: string): string {
	return escapeText(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
