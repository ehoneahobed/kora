import { cp, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const sourceDir = resolve(root, 'src', 'extension')
const targetDir = resolve(root, 'dist', 'extension')

await mkdir(targetDir, { recursive: true })
await cp(resolve(sourceDir, 'manifest.json'), resolve(targetDir, 'manifest.json'))
await cp(resolve(sourceDir, 'devtools-page.html'), resolve(targetDir, 'devtools-page.html'))
