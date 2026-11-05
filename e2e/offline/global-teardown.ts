import { rmSync } from 'node:fs'

/**
 * Removes the apps this run scaffolded (each has its own node_modules and build), unless the
 * directory was chosen by the caller or `KORA_OFFLINE_KEEP=1`.
 */
export default function globalTeardown(): void {
	const dir = process.env.KORA_OFFLINE_APPS_DIR
	if (!dir || process.env.KORA_OFFLINE_KEEP === '1') return
	if (!/kora-offline-suite[\\/]apps-\d+-\d+$/.test(dir)) return
	rmSync(dir, { recursive: true, force: true })
}
