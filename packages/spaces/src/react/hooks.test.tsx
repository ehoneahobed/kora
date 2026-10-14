// @vitest-environment jsdom
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HybridLogicalClock, createOperation, defineSchema, member, owner, t } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { KoraProvider } from '@korajs/react'
import { Store } from '@korajs/store'
import { BetterSqlite3Adapter } from '@korajs/store/better-sqlite3'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { type ReactElement, createElement, useState } from 'react'
import { afterEach, describe, expect, test } from 'vitest'
import { spacesCollections } from '../schema/spaces-collections'
import { useInvitations, useMembers, useMyRole } from './hooks'

const sharing = spacesCollections({
	roles: ['viewer', 'editor', 'admin', 'owner'],
	ownerRole: 'owner',
	manageRole: 'admin',
	groups: { forms: { owner: 'ownerId' }, boards: { owner: 'ownerId' } },
})

const schema = defineSchema({
	version: 1,
	access: sharing.access,
	collections: {
		...sharing.collections,
		forms: {
			fields: { title: t.string(), ownerId: t.string().stamp('userId') },
			access: { read: member('id'), create: owner('ownerId') },
		},
		boards: {
			fields: { title: t.string(), ownerId: t.string().stamp('userId') },
			access: { read: member('id'), create: owner('ownerId') },
		},
	},
})

const dirs: string[] = []
const stores: Store[] = []
afterEach(async () => {
	cleanup()
	for (const store of stores.splice(0)) await store.close()
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function openStore(): Promise<Store> {
	const dir = mkdtempSync(join(tmpdir(), 'spaces-hooks-'))
	dirs.push(dir)
	const store = new Store({
		schema,
		adapter: new BetterSqlite3Adapter(join(dir, 'device.db')),
		emitter: new SimpleEventEmitter(),
	})
	await store.open()
	stores.push(store)
	return store
}

function renderWith(store: Store, ui: ReactElement) {
	const app = { ready: Promise.resolve(), getStore: () => store, getSyncEngine: () => null }
	return render(createElement(KoraProvider, { app }, ui))
}

describe('spaces hooks', () => {
	test('useMembers lists the owner first, then members by role, and follows changes', async () => {
		const store = await openStore()
		const form = (await store.collection('forms').insert({ title: 'Survey', ownerId: 'ann' })) as {
			id: string
		}
		const members = store.collection('space_members')
		await members.insert({
			userId: 'dan',
			group: `forms:${form.id}`,
			role: 'viewer',
			invitedBy: 'ann',
		})
		await members.insert({
			userId: 'bob',
			group: `forms:${form.id}`,
			role: 'admin',
			invitedBy: 'ann',
		})
		await members.insert({ userId: 'old', group: `forms:${form.id}`, role: 'editor', expiresAt: 1 })
		await members.insert({ userId: 'zed', group: 'forms:other', role: 'admin' })
		// A role the schema does not have grants nothing.
		await members.insert({ userId: 'ghost', group: `forms:${form.id}`, role: 'superuser' })

		let seen: ReturnType<typeof useMembers<string>> = []
		function Members(): null {
			seen = useMembers<string>(['forms', form.id], { profile: (id) => id.toUpperCase() })
			return null
		}
		renderWith(store, createElement(Members))
		await waitFor(() => expect(seen).toHaveLength(3))
		expect(seen.map((m) => [m.userId, m.role, m.isOwner, m.profile])).toEqual([
			['ann', 'owner', true, 'ANN'],
			['bob', 'admin', false, 'BOB'],
			['dan', 'viewer', false, 'DAN'],
		])
		expect(seen[1]?.invitedBy).toBe('ann')

		const cat = (await members.insert({
			userId: 'cat',
			group: `forms:${form.id}`,
			role: 'editor',
		})) as { id: string }
		await waitFor(() => expect(seen.map((m) => m.userId)).toEqual(['ann', 'bob', 'cat', 'dan']))
		await members.delete(cat.id)
		await waitFor(() => expect(seen.map((m) => m.userId)).toEqual(['ann', 'bob', 'dan']))
	})

	test('useMembers lists members without the owner when the space record is not on the device', async () => {
		const store = await openStore()
		await store
			.collection('space_members')
			.insert({ userId: 'bob', group: 'forms:unseen', role: 'viewer' })
		let seen: ReturnType<typeof useMembers> = []
		function Members(): null {
			seen = useMembers(['forms', 'unseen'])
			return null
		}
		renderWith(store, createElement(Members))
		await waitFor(() => expect(seen.map((m) => m.userId)).toEqual(['bob']))
	})

	test('useMyRole: the owner field first, then the highest live membership', async () => {
		const store = await openStore()
		const form = (await store.collection('forms').insert({ title: 'Survey', ownerId: 'ann' })) as {
			id: string
		}
		// A membership row holding the owner role counts as the manager role.
		await store
			.collection('space_members')
			.insert({ userId: 'dan', group: `forms:${form.id}`, role: 'owner' })
		// A row with a role the schema does not have comes first and must be ignored.
		await store
			.collection('space_members')
			.insert({ userId: 'cat', group: `forms:${form.id}`, role: 'superuser' })
		await store
			.collection('space_members')
			.insert({ userId: 'bob', group: `forms:${form.id}`, role: 'editor' })
		const roles: Record<string, string | null> = {}
		function Role({ user }: { user: string | null }): null {
			roles[String(user)] = useMyRole(['forms', form.id], user)
			return null
		}
		renderWith(
			store,
			createElement('div', null, [
				createElement(Role, { key: 'a', user: 'ann' }),
				createElement(Role, { key: 'b', user: 'bob' }),
				createElement(Role, { key: 'c', user: 'cat' }),
				createElement(Role, { key: 'd', user: 'dan' }),
				createElement(Role, { key: 'n', user: null }),
			]),
		)
		await waitFor(() =>
			expect(roles).toEqual({ ann: 'owner', bob: 'editor', cat: null, dan: 'admin', null: null }),
		)
	})

	test('useInvitations lists pending invitations newest first, expired ones flagged', async () => {
		const store = await openStore()
		const invitations = store.collection('space_invitations')
		const base = { group: 'forms:f1', invitedBy: 'ann', tokenVersion: 1 }
		await invitations.insert({
			...base,
			email: 'a@example.com',
			role: 'viewer',
			createdAt: 1,
			expiresAt: 2,
		})
		await invitations.insert({
			...base,
			email: 'b@example.com',
			role: 'editor',
			createdAt: 5,
			expiresAt: Date.now() + 60_000,
		})
		let seen: ReturnType<typeof useInvitations> = []
		function Invitations(): null {
			seen = useInvitations(['forms', 'f1'])
			return null
		}
		renderWith(store, createElement(Invitations))
		await waitFor(() => expect(seen).toHaveLength(2))
		expect(seen.map((i) => [i.email, i.expired])).toEqual([
			['b@example.com', false],
			['a@example.com', true],
		])
	})

	test('a membership that expires while mounted leaves the list and the role at that moment', async () => {
		const store = await openStore()
		const form = (await store.collection('forms').insert({ title: 'Survey', ownerId: 'ann' })) as {
			id: string
		}
		const members = store.collection('space_members')
		await members.insert({
			userId: 'bob',
			group: `forms:${form.id}`,
			role: 'editor',
			expiresAt: Date.now() + 300,
		})
		let seen: ReturnType<typeof useMembers> = []
		let bobRole: string | null = null
		function View(): null {
			seen = useMembers(['forms', form.id])
			bobRole = useMyRole(['forms', form.id], 'bob')
			return null
		}
		renderWith(store, createElement(View))
		await waitFor(() => expect(seen.map((m) => m.userId)).toEqual(['ann', 'bob']))
		expect(bobRole).toBe('editor')
		await waitFor(() => expect(seen.map((m) => m.userId)).toEqual(['ann']), { timeout: 2000 })
		expect(bobRole).toBeNull()
	})

	test('switching to another collection never shows the previous record’s owner', async () => {
		const store = await openStore()
		const form = (await store.collection('forms').insert({ title: 'Form', ownerId: 'ann' })) as {
			id: string
		}
		// The board shares the form's id but belongs to bob.
		const board = await createOperation(
			{
				nodeId: 'remote-device',
				type: 'insert',
				collection: 'boards',
				recordId: form.id,
				data: { title: 'Board', ownerId: 'bob' },
				previousData: null,
				sequenceNumber: 1,
				causalDeps: [],
				schemaVersion: 1,
			},
			new HybridLogicalClock('remote-device'),
		)
		await store.applyRemoteOperation(board)
		const seen: Array<string | null> = []
		let switchTo: (space: readonly [string, string]) => void = () => {}
		function Role(): null {
			const [space, setSpace] = useState<readonly [string, string]>(['forms', form.id])
			switchTo = setSpace
			seen.push(useMyRole(space, 'ann'))
			return null
		}
		renderWith(store, createElement(Role))
		await waitFor(() => expect(seen.at(-1)).toBe('owner'))
		const before = seen.length
		act(() => switchTo(['boards', form.id]))
		await new Promise((resolve) => setTimeout(resolve, 100))
		expect(seen.slice(before)).not.toContain('owner')
		expect(seen.at(-1)).toBeNull()
	})
})
