import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Which Kora Cloud project a directory deploys to. Opaque ids only: nothing secret. */
export interface ProjectLink {
	organizationId: string
	projectId: string
}

export function projectLinkPath(projectRoot: string): string {
	return join(projectRoot, '.kora', 'cloud.json')
}

export async function readProjectLink(projectRoot: string): Promise<ProjectLink | null> {
	try {
		const parsed = JSON.parse(await readFile(projectLinkPath(projectRoot), 'utf8')) as Record<
			string,
			unknown
		>
		return typeof parsed.organizationId === 'string' && typeof parsed.projectId === 'string'
			? { organizationId: parsed.organizationId, projectId: parsed.projectId }
			: null
	} catch {
		return null
	}
}

export async function writeProjectLink(projectRoot: string, link: ProjectLink): Promise<void> {
	await mkdir(join(projectRoot, '.kora'), { recursive: true })
	await writeFile(projectLinkPath(projectRoot), `${JSON.stringify(link, null, 2)}\n`)
}
