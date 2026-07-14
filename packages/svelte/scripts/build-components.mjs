import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from 'svelte/compiler'

const rootDir = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(rootDir, '..')
const componentsDir = path.join(packageRoot, 'src', 'components')
const outDir = path.join(packageRoot, 'dist', 'components')

const components = ['KoraQuery', 'KoraRichText', 'KoraProvider', 'KoraStoreProvider']

async function buildComponent(name) {
	const sourcePath = path.join(componentsDir, `${name}.svelte`)
	const source = await readFile(sourcePath, 'utf8')

	const result = compile(source, {
		filename: sourcePath,
		generate: 'client',
		css: 'injected',
	})

	await writeFile(path.join(outDir, `${name}.js`), `${result.js.code}\n`, 'utf8')

	if (result.css?.code) {
		await writeFile(path.join(outDir, `${name}.css`), `${result.css.code}\n`, 'utf8')
	}
}

await mkdir(outDir, { recursive: true })

for (const name of components) {
	await buildComponent(name)
}

console.log(`Compiled ${components.length} Svelte components to dist/components/`)
