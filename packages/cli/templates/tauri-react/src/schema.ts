import { defineSchema, t } from '@korajs/core'

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
