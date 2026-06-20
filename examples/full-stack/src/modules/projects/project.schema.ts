import { t } from 'korajs'

export const projects = {
	fields: {
		name: t.string(),
		active: t.boolean().default(true),
		createdAt: t.timestamp().auto(),
	},
	indexes: ['active', 'createdAt'],
}
