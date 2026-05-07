import type { DeployAdapter, DeployPlatform } from './adapter'
import { AwsEcsAdapter } from './aws-ecs-adapter'
import { AwsLightsailAdapter } from './aws-lightsail-adapter'
import { FlyAdapter } from './fly-adapter'
import { RailwayAdapter } from './railway-adapter'
import { StubDeployAdapter } from './stub-adapter'

/**
 * Creates a deploy adapter instance for the selected platform.
 */
export function createDeployAdapter(platform: DeployPlatform): DeployAdapter {
	switch (platform) {
		case 'fly':
			return new FlyAdapter()
		case 'railway':
			return new RailwayAdapter()
		case 'aws-ecs':
			return new AwsEcsAdapter()
		case 'aws-lightsail':
			return new AwsLightsailAdapter()
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
