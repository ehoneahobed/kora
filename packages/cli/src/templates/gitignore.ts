import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The .gitignore every scaffolded app starts with. It lives here, not as a template file:
 * npm drops `.gitignore` files from a published package. A new app writes secrets
 * (`.env`, with KORA_AUTH_SECRET) and local databases (`.kora/`, `*.db`) on first run.
 */
const GITIGNORE = `# Dependencies and build output
node_modules
dist
*.tsbuildinfo

# Secrets: .env holds KORA_AUTH_SECRET and database URLs. Commit .env.example instead.
.env
.env.*
!.env.example

# Local databases (the dev sync server, auth, backups)
.kora/
*.db
*.db-shm
*.db-wal

# Logs and editor files
*.log
.DS_Store
`

const TAURI_LINES = `
# Tauri (Rust build output)
src-tauri/target
`

/**
 * Write `.gitignore` into a freshly scaffolded app, unless the template already provides one.
 *
 * @param targetDir - The scaffolded app
 * @param options - `tauri`: add the Rust build directory
 */
export async function writeGitignore(
	targetDir: string,
	options: { tauri: boolean },
): Promise<void> {
	const path = join(targetDir, '.gitignore')
	try {
		await access(path)
		return
	} catch {
		// none yet
	}
	await writeFile(path, options.tauri ? GITIGNORE + TAURI_LINES : GITIGNORE)
}
