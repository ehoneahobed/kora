import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
/**
 * A test network keeps its device databases in a temporary directory: it must be
 * removed however the network ends, or repeated runs fill the disk.
 */
import { defineSchema, t } from '@korajs/core'
import type { SchemaDefinition } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { createMixedTestNetwork, createTestNetwork } from '../src/index'
import {
	closeOpenNetworks,
	pendingTempDirectories,
	removePendingTempDirs,
	setTempDirRemover,
} from '../src/test-network'

const schema = defineSchema({
	version: 1,
	collections: {
		projects: { fields: { name: t.string() } },
		todos: { fields: { title: t.string(), projectId: t.string().optional() } },
	},
	relations: {
		todoProject: {
			from: 'todos',
			to: 'projects',
			type: 'many-to-one',
			field: 'projectId',
			onDelete: 'cascade',
		},
	},
}) as unknown as SchemaDefinition

const savedTmpdir = process.env.TMPDIR
let scratch: string | null = null

/** Point `os.tmpdir()` at an empty directory of this test, to see what is left in it. */
function isolateTmpdir(): string {
	scratch = mkdtempSync(join(tmpdir(), 'kora-cleanup-check-'))
	process.env.TMPDIR = scratch
	return scratch
}

afterEach(() => {
	setTempDirRemover(null)
	if (savedTmpdir === undefined) Reflect.deleteProperty(process.env, 'TMPDIR')
	else process.env.TMPDIR = savedTmpdir
	if (scratch) rmSync(scratch, { recursive: true, force: true })
	scratch = null
})

describe('test network temporary directories', () => {
	test('close() removes the directory', async () => {
		const network = await createTestNetwork(schema, { devices: 2 })
		expect(existsSync(network.tmpDir)).toBe(true)
		await network.close()
		expect(existsSync(network.tmpDir)).toBe(false)
	})

	test('close() removes the directory even when closing a device fails', async () => {
		const network = await createTestNetwork(schema, { devices: 1 })
		const [device] = network.devices
		if (!device) throw new Error('no device')
		const close = device.close.bind(device)
		device.close = async () => {
			await close()
			throw new Error('device close failed')
		}
		await expect(network.close()).rejects.toThrow('device close failed')
		expect(existsSync(network.tmpDir)).toBe(false)
	})

	test('a network whose creation fails leaves nothing behind', async () => {
		const dir = isolateTmpdir()
		// A sealed foreign key on a cascade relation is refused when the device opens.
		await expect(
			createTestNetwork(schema, {
				devices: 2,
				encryption: {
					config: { enabled: true, key: 'k' },
					salt: new Uint8Array(16).fill(7),
					iterations: 1_000,
				},
			}),
		).rejects.toMatchObject({ code: 'SEALED_RELATION_FIELD' })
		expect(readdirSync(dir)).toEqual([])
	})

	test('a mixed network removes its directory on close()', async () => {
		const network = await createMixedTestNetwork(schema, {}, [{ name: 'a', schema }])
		await network.close()
		expect(existsSync(network.tmpDir)).toBe(false)
	})

	test('the exit fallback closes a network left open before removing its directory', async () => {
		const network = await createTestNetwork(schema, { devices: 2 })
		const events: string[] = []
		// A platform (Windows) that refuses to remove a directory whose files are open.
		let open = network.devices.length
		for (const device of network.devices) {
			const close = device.close.bind(device)
			device.close = async () => {
				await close()
				open -= 1
				events.push(`close ${device.name}`)
			}
		}
		setTempDirRemover((dir) => {
			events.push('remove')
			if (open > 0) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' })
			rmSync(dir, { recursive: true, force: true })
		})
		await closeOpenNetworks()
		expect(events).toEqual(['close device-0', 'close device-1', 'remove'])
		expect(existsSync(network.tmpDir)).toBe(false)
		expect(pendingTempDirectories()).not.toContain(network.tmpDir)
	})

	test('a removal that fails after closing is retried once', async () => {
		const network = await createTestNetwork(schema, { devices: 1 })
		let attempts = 0
		setTempDirRemover((dir) => {
			attempts += 1
			if (attempts === 1) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' })
			rmSync(dir, { recursive: true, force: true })
		})
		await network.close()
		expect(attempts).toBe(2)
		expect(existsSync(network.tmpDir)).toBe(false)
	})

	test('the exit last resort keeps a path it could not remove', async () => {
		const network = await createTestNetwork(schema, { devices: 1 })
		setTempDirRemover(() => {
			throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' })
		})
		await network.close()
		expect(pendingTempDirectories()).toContain(network.tmpDir)
		removePendingTempDirs()
		expect(pendingTempDirectories()).toContain(network.tmpDir)
		setTempDirRemover(null)
		removePendingTempDirs()
		expect(pendingTempDirectories()).not.toContain(network.tmpDir)
		expect(existsSync(network.tmpDir)).toBe(false)
	})
})
