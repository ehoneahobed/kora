import { defineSchema } from 'korajs'
import { projects } from './modules/projects/project.schema'
import { todos } from './modules/todos/todo.schema'

export default defineSchema({
	version: 1,
	collections: {
		projects,
		todos,
	},
	relations: {
		todoBelongsToProject: {
			from: 'todos',
			to: 'projects',
			type: 'many-to-one',
			field: 'projectId',
			onDelete: 'cascade',
		},
	},
})
