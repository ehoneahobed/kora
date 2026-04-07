import type { DeployAdapter, DeployPlatform } from './adapter'
import { FlyAdapter } from './fly-adapter'
import { StubDeployAdapter } from './stub-adapter'

/**
 * Creates a deploy adapter instance for the selected platform.
 */
export function createDeployAdapter(platform: DeployPlatform): DeployAdapter {
	switch (platform) {
		case 'fly':
			return new FlyAdapter()
		case 'railway':
		case 'render':
		case 'docker':
		case 'kora-cloud':
			return new StubDeployAdapter(platform)
		default: {
			const exhaustiveCheck: never = platform
			return exhaustiveCheck
		}
	}
}
