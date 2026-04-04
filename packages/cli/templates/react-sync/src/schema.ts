import { defineSchema, t } from 'kora'

export default defineSchema({
  version: 1,
  collections: {
    todos: {
      fields: {
        title: t.string(),
        completed: t.boolean().default(false),
        createdAt: t.timestamp().auto(),
      },
      indexes: ['completed'],
    },
  },
})
