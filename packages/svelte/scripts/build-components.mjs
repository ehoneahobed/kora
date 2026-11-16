import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from 'svelte/compiler'

const rootDir = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(rootDir, '..')
const componentsDir = path.join(packageRoot, 'src', 'components')
const outDir = path.join(packageRoot, 'dist', 'components')

// The public components and the internal bridges they render.
const components = [
	'KoraQuery',
	'KoraRichText',
	'KoraProvider',
	'KoraStoreProvider',
	'KoraContextBridge',
	'KoraStoreBridge',
]

/**
 * The compiled components sit in dist/components, where neither `../context` (bundled into
 * dist/index.js) nor a `.svelte` file exists: point those imports at the built files.
 */
function rewriteImports(code) {
	return code
		.replace(/from '\.\/([A-Za-z]+)\.svelte'/g, "from './$1.js'")
		.replace(/from '\.\.\/context'/g, "from '../index.js'")
}

async function buildComponent(name) {
	const sourcePath = path.join(componentsDir, `${name}.svelte`)
	const source = await readFile(sourcePath, 'utf8')

	const result = compile(source, {
		filename: sourcePath,
		generate: 'client',
		css: 'injected',
	})

	await writeFile(path.join(outDir, `${name}.js`), `${rewriteImports(result.js.code)}\n`, 'utf8')

	if (result.css?.code) {
		await writeFile(path.join(outDir, `${name}.css`), `${result.css.code}\n`, 'utf8')
	}
}

await mkdir(outDir, { recursive: true })

for (const name of components) {
	await buildComponent(name)
}

console.log(`Compiled ${components.length} Svelte components to dist/components/`)
