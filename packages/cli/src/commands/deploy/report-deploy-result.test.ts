import { describe, expect, test, vi } from 'vitest'
import { reportDeployResult } from './deploy-command'

function logger() {
	return { success: vi.fn(), warn: vi.fn(), step: vi.fn() }
}

describe('reportDeployResult', () => {
	test('a deploy that stopped short is never reported as completed', () => {
		const log = logger()
		reportDeployResult(log, {
			deploymentId: 'd1',
			liveUrl: null,
			syncUrl: null,
			pendingSetup: 'Create the ECS service.',
		})
		expect(log.success).not.toHaveBeenCalled()
		expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Create the ECS service.'))
	})

	test('a running deploy with a known URL names it', () => {
		const log = logger()
		reportDeployResult(log, {
			deploymentId: 'd1',
			liveUrl: 'https://app.example',
			syncUrl: 'wss://app.example/kora-sync',
		})
		expect(log.success).toHaveBeenCalledWith('Deployment completed: https://app.example')
		expect(log.step).toHaveBeenCalledWith('Sync endpoint: wss://app.example/kora-sync')
	})

	test('a running deploy without a URL says so instead of inventing one', () => {
		const log = logger()
		reportDeployResult(log, { deploymentId: 'd1', liveUrl: null, syncUrl: null })
		expect(log.success).toHaveBeenCalledWith(
			'Deployment completed. The platform did not report a public URL for it.',
		)
	})
})
