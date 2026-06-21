/**
 * Smoke test for the full-stack example — exercises the same packages the app uses at runtime.
 * Run with: pnpm verify
 */
import { createTestNetwork, expectConverged } from '@korajs/test'
import { createApp } from 'korajs'
import schema from '../src/schema'

function requireDevice<T>(devices: T[], index: number, label: string): T {
	const device = devices[index]
	if (!device) {
		throw new Error(`expected ${label} at index ${index}`)
	}
	return device
}

async function verifyLocalApp(): Promise<void> {
	const app = createApp({
		schema,
		store: { adapter: 'better-sqlite3', name: ':memory:full-stack-verify' },
	})

	await app.ready

	const project = await app.projects.insert({ name: 'Verification project' })
	const todo = await app.todos.insert({ title: 'Local CRUD', projectId: project.id })
	await app.todos.update(todo.id, { completed: true })

	const orderNo = await app.sequences.next('order', { format: 'ORD-{seq:4}' })
	if (!orderNo.startsWith('ORD-')) {
		throw new Error(`unexpected sequence format: ${orderNo}`)
	}

	await app.transaction(async (tx) => {
		const todosTx = tx.todos
		if (!todosTx) {
			throw new Error('expected todos collection on transaction')
		}
		await todosTx.insert({ title: 'Transaction insert' })
	})

	const todos = await app.todos.where({}).exec()
	if (todos.length < 2) {
		throw new Error(`expected at least 2 todos, got ${todos.length}`)
	}

	const backup = await app.exportBackup()
	if (backup.byteLength === 0) {
		throw new Error('exportBackup returned empty payload')
	}

	const ops = await app.getStore().getOperationRange(app.getStore().getNodeId(), 1, 100)
	const todoInsert = ops.find((op) => op.type === 'insert' && op.collection === 'todos')
	if (!todoInsert) {
		throw new Error('expected a todo insert operation in the log')
	}

	const snapshot = await app.replayTo(todoInsert.id)
	if ((snapshot.collections.todos ?? []).length !== 1) {
		throw new Error(
			`replayTo expected 1 todo at insert cut, got ${(snapshot.collections.todos ?? []).length}`,
		)
	}

	const audit = await app.exportAudit()
	if (audit.byteLength === 0) {
		throw new Error('exportAudit returned empty payload')
	}

	await app.projects.delete(project.id)
	const remaining = await app.todos.where({}).exec()
	if (remaining.some((row) => row.projectId === project.id)) {
		throw new Error('cascade delete did not remove dependent todos')
	}

	await app.close()
	console.log('✓ local app (store, sequences, transactions, backup, replay, audit, cascade delete)')
}

async function verifySyncConvergence(): Promise<void> {
	const network = await createTestNetwork(schema, { devices: 2 })
	try {
		const deviceA = requireDevice(network.devices, 0, 'device A')
		const deviceB = requireDevice(network.devices, 1, 'device B')

		const project = await deviceA.collection('projects').insert({ name: 'Synced project' })
		await deviceA.collection('todos').insert({
			title: 'Synced todo',
			projectId: project.id,
		})

		await deviceA.sync()
		await deviceB.sync()
		await expectConverged(network.devices, schema)

		const todosOnB = await deviceB.getState('todos')
		if (todosOnB.length !== 1) {
			throw new Error(`expected 1 todo on device B, got ${todosOnB.length}`)
		}

		console.log('✓ sync convergence (sync, merge, server, test harness)')
	} finally {
		await network.close()
	}
}

async function main(): Promise<void> {
	console.log('Kora full-stack framework verification\n')
	await verifyLocalApp()
	await verifySyncConvergence()
	console.log('\nAll framework checks passed.')
}

main().catch((error: unknown) => {
	console.error('\nVerification failed:', error)
	process.exit(1)
})
