import { defineSchema } from 'korajs'
import { todos } from './modules/todos/todo.schema'

export default defineSchema({
	version: 1,
	collections: {
		todos,
	},
})
