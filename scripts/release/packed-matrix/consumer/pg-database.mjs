/**
 * `node pg-database.mjs create` prints `{ "name": ..., "url": ... }` for a new empty database on
 * the server named by KORA_PG_URL; `node pg-database.mjs drop <name>` removes it. The matrix
 * gives every check that needs Postgres a database of its own.
 */
import postgres from 'postgres'

const base = process.env.KORA_PG_URL
const [action, existing] = process.argv.slice(2)
if (!base) {
	process.stderr.write('KORA_PG_URL names the Postgres server to use\n')
	process.exit(2)
}
const admin = postgres(base, { max: 1, onnotice: () => {} })
try {
	if (action === 'create') {
		const name = `kora_matrix_${process.pid}_${Date.now()}`
		await admin.unsafe(`CREATE DATABASE ${name}`)
		const url = new URL(base)
		url.pathname = `/${name}`
		process.stdout.write(`${JSON.stringify({ name, url: url.toString() })}\n`)
	} else if (action === 'drop' && existing) {
		await admin.unsafe(`DROP DATABASE IF EXISTS ${existing} WITH (FORCE)`)
	} else {
		process.stderr.write('usage: pg-database.mjs create | drop <name>\n')
		process.exit(2)
	}
} finally {
	await admin.end()
}
