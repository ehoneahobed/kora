import { t } from 'korajs'

export const todos = {
  fields: {
    title: t.string(),
    completed: t.boolean().default(false),
    createdAt: t.timestamp().auto(),
  },
  indexes: ['completed', 'createdAt'],
}
