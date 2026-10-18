/**
 * A capability grant (a share link, `AuthContext.accessGrants`) opens a space's content,
 * never its collaborators: the member list and pending invitations are for real members
 * (and invitations for real managers) only, whatever role the link names.
 */
import type { AuthContext, ServerTransport } from '@korajs/server'
import { TokenAuthProvider } from '@korajs/server'
import type { SyncMessage } from '@korajs/sync'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { SPACE_INVITATIONS, SPACE_MEMBERS } from '../../src/index'
import { type Harness, STORE_KINDS, type StoreKind, createHarness, schema } from './fixture'

const auth = new TokenAuthProvider({
	validate: async (token): Promise<AuthContext | null> => {
		// `link:<form>:<role>`: an anonymous visitor holding a share link.
		if (token.startsWith('link:')) {
			const [, formId, role] = token.split(':')
			return {
				userId: `anon-${token}`,
				anonymous: true,
				accessGrants: [{ group: ['forms', formId ?? ''], role: role ?? 'viewer' }],
			}
		}
		// `grant:<user>:<form>:<role>`: a signed-in user holding a link too.
		if (token.startsWith('grant:')) {
			const [, userId, formId, role] = token.split(':')
			return {
				userId: userId ?? '',
				accessGrants: [{ group: ['forms', formId ?? ''], role: role ?? 'viewer' }],
			}
		}
		return { userId: token }
	},
})

const open: Harness[] = []
afterEach(async () => {
	for (const h of open.splice(0)) await h.close()
})

/** A sync session on the harness's server, collecting what it is sent. */
async function sync(h: Harness, token: string, nodeId: string): Promise<string[]> {
	const messages: SyncMessage[] = []
	let deliver: ((message: SyncMessage) => void) | null = null
	let connected = true
	const transport: ServerTransport = {
		send: (message) => {
			messages.push(message)
		},
		onMessage: (handler) => {
			deliver = handler
		},
		onClose: () => {},
		onError: () => {},
		isConnected: () => connected,
		close: () => {
			connected = false
		},
	}
	h.server.handleConnection(transport)
	deliver?.({
		type: 'handshake',
		messageId: `hs-${nodeId}`,
		nodeId,
		versionVector: {},
		schemaVersion: schema.version,
		authToken: token,
		supportsScopeDisjunction: true,
		lastDeliverySequence: 0,
	} as unknown as SyncMessage)
	await vi.waitFor(() =>
		expect(messages.some((m) => m.type === 'handshake-response' || m.type === 'error')).toBe(true),
	)
	await vi.waitFor(() =>
		expect(
			messages.some(
				(m) => m.type === 'operation-batch' && (m as { isFinal?: boolean }).isFinal === true,
			),
		).toBe(true),
	)
	transport.close()
	return messages.flatMap((m) =>
		m.type === 'operation-batch'
			? (m.operations as Array<{ collection: string; recordId: string }>).map(
					(op) => `${op.collection}/${op.recordId}`,
				)
			: [],
	)
}

const of = (keys: string[], collection: string): string[] =>
	keys.filter((key) => key.startsWith(`${collection}/`))

describe.each(STORE_KINDS)('link holders on the %s store', (kind: StoreKind) => {
	async function setup(): Promise<Harness> {
		const h = await createHarness(kind, {}, { auth })
		open.push(h)
		await h.createForm('f1', 'ann')
		await h.join('ann', 'bob', 'f1', 'editor')
		const invited = await h.call('ann', '/invitations/create', {
			space: ['forms', 'f1'],
			email: 'cat@example.com',
			role: 'viewer',
		})
		expect(invited.status).toBe(200)
		return h
	}

	test('an anonymous link holder gets the form, not its members or invitations', async () => {
		const h = await setup()
		// Even a link naming the manager role reveals no collaborators.
		const got = await sync(h, 'link:f1:admin', 'visitor-node')
		expect(got).toContain('forms/f1')
		expect(of(got, SPACE_MEMBERS)).toEqual([])
		expect(of(got, SPACE_INVITATIONS)).toEqual([])
	})

	test('a signed-in user holding only a link sees none of them either', async () => {
		const h = await setup()
		const got = await sync(h, 'grant:dan:f1:admin', 'dan-node')
		expect(got).toContain('forms/f1')
		expect(of(got, SPACE_MEMBERS)).toEqual([])
		expect(of(got, SPACE_INVITATIONS)).toEqual([])
	})

	test('members see the member list; the owner sees invitations too', async () => {
		const h = await setup()
		const bob = await sync(h, 'bob', 'bob-node')
		expect(of(bob, SPACE_MEMBERS).length).toBeGreaterThan(0)
		// An editor is no manager: no invitations.
		expect(of(bob, SPACE_INVITATIONS)).toEqual([])
		const ann = await sync(h, 'ann', 'ann-node')
		expect(of(ann, SPACE_MEMBERS).length).toBeGreaterThan(0)
		expect(of(ann, SPACE_INVITATIONS).length).toBeGreaterThan(0)
	})
})
