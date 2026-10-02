/**
 * RT-22 repro (red team round 3, 2026-10-02): foreign-key targets are authorized
 * against the writer's DOWNLINK scope only, so a child of a parent the writer may
 * create but not read (a form submission and its answers) is refused.
 *
 * Asserts the CORRECT behaviour (fails before the fix): the parent may be inside the
 * writer's uplink OR downlink scope; a parent in neither is still refused (RT-13).
 */
import { defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import { batch, createHarness, makeOp, tick } from './rt-fixture'

const schema = defineSchema({
	version: 1,
	collections: {
		forms: { fields: { title: t.string() } },
		submissions: { fields: { formId: t.string(), respondent: t.string() } },
		answers: { fields: { submissionId: t.string(), respondent: t.string(), value: t.string() } },
	},
	relations: {
		submissionForm: {
			from: 'submissions',
			to: 'forms',
			type: 'many-to-one',
			field: 'formId',
			onDelete: 'restrict',
		},
		answerSubmission: {
			from: 'answers',
			to: 'submissions',
			type: 'many-to-one',
			field: 'submissionId',
			onDelete: 'cascade',
		},
	},
})

// Respondents read forms and write submissions and answers they can never read back.
const auth = new TokenAuthProvider({
	validate: async (token) => {
		const user = token.split('-')[0] ?? ''
		if (user === 'admin')
			return { userId: 'admin', scopes: { forms: {}, submissions: {}, answers: {} } }
		return {
			userId: user,
			downlinkScopes: { forms: {} },
			uplinkScopes: { submissions: { respondent: user }, answers: { respondent: user } },
		}
	},
})

function rejectedIds(messages: SyncMessage[]): string[] {
	return messages.flatMap((m) =>
		m.type === 'operation-rejected' ? [(m as { operationId: string }).operationId] : [],
	)
}

describe('RT-22: foreign keys to write-only parents', () => {
	test('a respondent may answer the submission it just created', async () => {
		const harness = await createHarness(schema, auth)
		const admin = await harness.login('admin-token', 'admin-node')
		admin.send(
			batch([
				makeOp('admin-node', 1, {
					collection: 'forms',
					recordId: 'form-1',
					data: { title: 'Survey' },
				}),
			]),
		)
		await tick()

		const ann = await harness.login('ann-token', 'ann-node')
		const submission = makeOp('ann-node', 1, {
			collection: 'submissions',
			recordId: 'sub-1',
			data: { formId: 'form-1', respondent: 'ann' },
		})
		const answer = makeOp('ann-node', 2, {
			collection: 'answers',
			recordId: 'ans-1',
			data: { submissionId: 'sub-1', respondent: 'ann', value: 'yes' },
			causalDeps: [submission.id],
		})
		ann.send(batch([submission, answer]))
		await tick()
		expect(rejectedIds(ann.messages)).toEqual([])
		expect(await harness.store.findRecord('answers', 'ans-1')).not.toBeNull()

		// Another respondent's submission is in neither of Bob's scopes: still refused.
		const bob = await harness.login('bob-token', 'bob-node')
		const hijack = makeOp('bob-node', 1, {
			collection: 'answers',
			recordId: 'ans-2',
			data: { submissionId: 'sub-1', respondent: 'bob', value: 'no' },
		})
		bob.send(batch([hijack]))
		await tick()
		expect(rejectedIds(bob.messages)).toContain(hijack.id)
	})
})
