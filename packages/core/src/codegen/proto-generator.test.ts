import { describe, expect, test } from 'vitest'
import { defineSchema } from '../schema/define'
import { t } from '../schema/types'
import type { SchemaDefinition } from '../types'
import { generateProtoDefinitions } from './proto-generator'
import type { ProtoOutput } from './proto-generator'

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────

/** Creates a minimal valid schema with the given collections input. */
function schemaWith(
	collections: Parameters<typeof defineSchema>[0]['collections'],
): SchemaDefinition {
	return defineSchema({ version: 1, collections })
}

// ──────────────────────────────────────────────────────────
// Proto header
// ──────────────────────────────────────────────────────────

describe('generateProtoDefinitions', () => {
	describe('proto header', () => {
		test('includes proto3 syntax declaration', () => {
			const schema = schemaWith({
				items: { fields: { name: t.string() } },
			})
			const { proto } = generateProtoDefinitions(schema)
			expect(proto).toContain('syntax = "proto3";')
		})

		test('includes kora package declaration', () => {
			const schema = schemaWith({
				items: { fields: { name: t.string() } },
			})
			const { proto } = generateProtoDefinitions(schema)
			expect(proto).toContain('package kora;')
		})
	})

	// ──────────────────────────────────────────────────────────
	// Type mappings
	// ──────────────────────────────────────────────────────────

	describe('type mappings', () => {
		test('string field maps to string', () => {
			const schema = schemaWith({
				items: { fields: { name: t.string() } },
			})
			const { proto, typeMap } = generateProtoDefinitions(schema)
			expect(proto).toContain('string name = 2;')
			expect(typeMap.get('items.name')).toBe('string')
		})

		test('number field maps to double', () => {
			const schema = schemaWith({
				items: { fields: { price: t.number() } },
			})
			const { proto, typeMap } = generateProtoDefinitions(schema)
			expect(proto).toContain('double price = 2;')
			expect(typeMap.get('items.price')).toBe('double')
		})

		test('boolean field maps to bool', () => {
			const schema = schemaWith({
				items: { fields: { active: t.boolean() } },
			})
			const { proto, typeMap } = generateProtoDefinitions(schema)
			expect(proto).toContain('bool active = 2;')
			expect(typeMap.get('items.active')).toBe('bool')
		})

		test('timestamp field maps to int64', () => {
			const schema = schemaWith({
				items: { fields: { createdAt: t.timestamp() } },
			})
			const { proto, typeMap } = generateProtoDefinitions(schema)
			// camelCase -> snake_case
			expect(proto).toContain('int64 created_at = 2;')
			expect(typeMap.get('items.createdAt')).toBe('int64')
		})

		test('richtext field maps to bytes', () => {
			const schema = schemaWith({
				items: { fields: { notes: t.richtext() } },
			})
			const { proto, typeMap } = generateProtoDefinitions(schema)
			expect(proto).toContain('bytes notes = 2;')
			expect(typeMap.get('items.notes')).toBe('bytes')
		})
	})

	// ──────────────────────────────────────────────────────────
	// Enum fields
	// ──────────────────────────────────────────────────────────

	describe('enum fields', () => {
		test('generates nested protobuf enum with UNSPECIFIED sentinel', () => {
			const schema = schemaWith({
				tasks: {
					fields: {
						priority: t.enum(['low', 'medium', 'high']),
					},
				},
			})
			const { proto } = generateProtoDefinitions(schema)

			expect(proto).toContain('enum TasksRecordPriority {')
			expect(proto).toContain('TASKSRECORDPRIORITY_UNSPECIFIED = 0;')
			expect(proto).toContain('TASKSRECORDPRIORITY_LOW = 1;')
			expect(proto).toContain('TASKSRECORDPRIORITY_MEDIUM = 2;')
			expect(proto).toContain('TASKSRECORDPRIORITY_HIGH = 3;')
		})

		test('uses enum type name in field declaration', () => {
			const schema = schemaWith({
				tasks: {
					fields: {
						priority: t.enum(['low', 'medium', 'high']),
					},
				},
			})
			const { proto } = generateProtoDefinitions(schema)
			expect(proto).toContain('TasksRecordPriority priority = 2;')
		})

		test('typeMap stores enum type name', () => {
			const schema = schemaWith({
				tasks: {
					fields: {
						priority: t.enum(['low', 'medium', 'high']),
					},
				},
			})
			const { typeMap } = generateProtoDefinitions(schema)
			expect(typeMap.get('tasks.priority')).toBe('TasksRecordPriority')
		})

		test('enum with default value still generates correctly', () => {
			const schema = schemaWith({
				tasks: {
					fields: {
						status: t.enum(['open', 'closed']).default('open'),
					},
				},
			})
			const { proto } = generateProtoDefinitions(schema)
			expect(proto).toContain('enum TasksRecordStatus {')
			expect(proto).toContain('TASKSRECORDSTATUS_OPEN = 1;')
			expect(proto).toContain('TASKSRECORDSTATUS_CLOSED = 2;')
		})
	})

	// ──────────────────────────────────────────────────────────
	// Array fields
	// ──────────────────────────────────────────────────────────

	describe('array fields', () => {
		test('array(string) generates repeated string', () => {
			const schema = schemaWith({
				items: { fields: { tags: t.array(t.string()) } },
			})
			const { proto, typeMap } = generateProtoDefinitions(schema)
			expect(proto).toContain('repeated string tags = 2;')
			expect(typeMap.get('items.tags')).toBe('repeated string')
		})

		test('array(number) generates repeated double', () => {
			const schema = schemaWith({
				items: { fields: { scores: t.array(t.number()) } },
			})
			const { proto, typeMap } = generateProtoDefinitions(schema)
			expect(proto).toContain('repeated double scores = 2;')
			expect(typeMap.get('items.scores')).toBe('repeated double')
		})

		test('array(boolean) generates repeated bool', () => {
			const schema = schemaWith({
				items: { fields: { flags: t.array(t.boolean()) } },
			})
			const { proto, typeMap } = generateProtoDefinitions(schema)
			expect(proto).toContain('repeated bool flags = 2;')
			expect(typeMap.get('items.flags')).toBe('repeated bool')
		})

		test('array(timestamp) generates repeated int64', () => {
			const schema = schemaWith({
				items: { fields: { dates: t.array(t.timestamp()) } },
			})
			const { proto, typeMap } = generateProtoDefinitions(schema)
			expect(proto).toContain('repeated int64 dates = 2;')
			expect(typeMap.get('items.dates')).toBe('repeated int64')
		})

		test('array with default value generates correctly', () => {
			const schema = schemaWith({
				items: { fields: { tags: t.array(t.string()).default([]) } },
			})
			const { proto } = generateProtoDefinitions(schema)
			expect(proto).toContain('repeated string tags = 2;')
		})
	})

	// ──────────────────────────────────────────────────────────
	// Collection messages
	// ──────────────────────────────────────────────────────────

	describe('collection messages', () => {
		test('message name is PascalCase collection name + "Record"', () => {
			const schema = schemaWith({
				todos: { fields: { title: t.string() } },
			})
			const { proto } = generateProtoDefinitions(schema)
			expect(proto).toContain('message TodosRecord {')
		})

		test('snake_case collection names produce correct PascalCase', () => {
			const schema = schemaWith({
				todo_items: { fields: { title: t.string() } },
			})
			const { proto } = generateProtoDefinitions(schema)
			expect(proto).toContain('message TodoItemsRecord {')
		})

		test('id is always field 1', () => {
			const schema = schemaWith({
				items: { fields: { name: t.string() } },
			})
			const { proto } = generateProtoDefinitions(schema)
			expect(proto).toContain('string id = 1;')
		})

		test('fields are numbered sequentially starting from 2', () => {
			const schema = schemaWith({
				items: {
					fields: {
						title: t.string(),
						count: t.number(),
						active: t.boolean(),
					},
				},
			})
			const { proto } = generateProtoDefinitions(schema)
			expect(proto).toContain('string title = 2;')
			expect(proto).toContain('double count = 3;')
			expect(proto).toContain('bool active = 4;')
		})

		test('camelCase field names are converted to snake_case', () => {
			const schema = schemaWith({
				items: {
					fields: {
						dueDate: t.timestamp(),
						isCompleted: t.boolean(),
					},
				},
			})
			const { proto } = generateProtoDefinitions(schema)
			expect(proto).toContain('int64 due_date = 2;')
			expect(proto).toContain('bool is_completed = 3;')
		})

		test('typeMap includes id field', () => {
			const schema = schemaWith({
				items: { fields: { name: t.string() } },
			})
			const { typeMap } = generateProtoDefinitions(schema)
			expect(typeMap.get('items.id')).toBe('string')
		})
	})

	// ──────────────────────────────────────────────────────────
	// Multiple collections
	// ──────────────────────────────────────────────────────────

	describe('multiple collections', () => {
		test('generates separate messages for each collection', () => {
			const schema = schemaWith({
				todos: { fields: { title: t.string() } },
				projects: { fields: { name: t.string() } },
			})
			const { proto } = generateProtoDefinitions(schema)
			expect(proto).toContain('message TodosRecord {')
			expect(proto).toContain('message ProjectsRecord {')
		})

		test('typeMap contains entries for all collections', () => {
			const schema = schemaWith({
				todos: { fields: { title: t.string() } },
				projects: { fields: { name: t.string() } },
			})
			const { typeMap } = generateProtoDefinitions(schema)
			expect(typeMap.get('todos.title')).toBe('string')
			expect(typeMap.get('projects.name')).toBe('string')
			expect(typeMap.get('todos.id')).toBe('string')
			expect(typeMap.get('projects.id')).toBe('string')
		})

		test('field numbers are independent per collection', () => {
			const schema = schemaWith({
				todos: { fields: { title: t.string() } },
				projects: { fields: { name: t.string() } },
			})
			const { proto } = generateProtoDefinitions(schema)
			// Both collections should have their first field at number 2
			const todoMatch = proto.match(/message TodosRecord \{[^}]*string title = 2;/)
			const projectMatch = proto.match(/message ProjectsRecord \{[^}]*string name = 2;/)
			expect(todoMatch).not.toBeNull()
			expect(projectMatch).not.toBeNull()
		})
	})

	// ──────────────────────────────────────────────────────────
	// Sync protocol messages
	// ──────────────────────────────────────────────────────────

	describe('sync protocol messages', () => {
		test('includes KoraOperation message with all fields', () => {
			const schema = schemaWith({
				items: { fields: { name: t.string() } },
			})
			const { proto } = generateProtoDefinitions(schema)

			expect(proto).toContain('message KoraOperation {')
			expect(proto).toContain('string id = 1;')
			expect(proto).toContain('string node_id = 2;')
			expect(proto).toContain('string type = 3;')
			expect(proto).toContain('string collection = 4;')
			expect(proto).toContain('string record_id = 5;')
			expect(proto).toContain('bytes data = 6;')
			expect(proto).toContain('bytes previous_data = 7;')
			expect(proto).toContain('int64 wall_time = 8;')
			expect(proto).toContain('int32 logical = 9;')
			expect(proto).toContain('string timestamp_node_id = 10;')
			expect(proto).toContain('int64 sequence_number = 11;')
			expect(proto).toContain('repeated string causal_deps = 12;')
			expect(proto).toContain('int32 schema_version = 13;')
		})

		test('includes OperationBatch message', () => {
			const schema = schemaWith({
				items: { fields: { name: t.string() } },
			})
			const { proto } = generateProtoDefinitions(schema)

			expect(proto).toContain('message OperationBatch {')
			expect(proto).toContain('repeated KoraOperation operations = 1;')
			expect(proto).toContain('bool is_final = 2;')
		})

		test('includes HandshakeMessage with map field', () => {
			const schema = schemaWith({
				items: { fields: { name: t.string() } },
			})
			const { proto } = generateProtoDefinitions(schema)

			expect(proto).toContain('message HandshakeMessage {')
			expect(proto).toContain('map<string, int64> version_vector = 1;')
			expect(proto).toContain('int32 schema_version = 2;')
			expect(proto).toContain('string node_id = 3;')
		})

		test('includes HandshakeResponse message', () => {
			const schema = schemaWith({
				items: { fields: { name: t.string() } },
			})
			const { proto } = generateProtoDefinitions(schema)

			expect(proto).toContain('message HandshakeResponse {')
			expect(proto).toContain('map<string, int64> version_vector = 1;')
			expect(proto).toContain('int32 schema_version = 2;')
		})

		test('includes Acknowledgment message', () => {
			const schema = schemaWith({
				items: { fields: { name: t.string() } },
			})
			const { proto } = generateProtoDefinitions(schema)

			expect(proto).toContain('message Acknowledgment {')
			expect(proto).toContain('int64 sequence_number = 1;')
			expect(proto).toContain('string node_id = 2;')
		})
	})

	// ──────────────────────────────────────────────────────────
	// JSON descriptor
	// ──────────────────────────────────────────────────────────

	describe('jsonDescriptor', () => {
		test('has nested.kora.nested structure', () => {
			const schema = schemaWith({
				items: { fields: { name: t.string() } },
			})
			const { jsonDescriptor } = generateProtoDefinitions(schema)

			expect(jsonDescriptor).toHaveProperty('nested')
			const nested = jsonDescriptor.nested as Record<string, unknown>
			expect(nested).toHaveProperty('kora')
			const kora = nested.kora as Record<string, unknown>
			expect(kora).toHaveProperty('nested')
		})

		test('includes collection record message', () => {
			const schema = schemaWith({
				todos: { fields: { title: t.string() } },
			})
			const { jsonDescriptor } = generateProtoDefinitions(schema)
			const kora = (jsonDescriptor.nested as Record<string, Record<string, unknown>>).kora
			const messages = kora.nested as Record<string, unknown>

			expect(messages).toHaveProperty('TodosRecord')
			const todosRecord = messages.TodosRecord as Record<string, unknown>
			const fields = todosRecord.fields as Record<string, Record<string, unknown>>

			expect(fields.id).toEqual({ type: 'string', id: 1 })
			expect(fields.title).toEqual({ type: 'string', id: 2 })
		})

		test('includes KoraOperation in descriptor', () => {
			const schema = schemaWith({
				items: { fields: { name: t.string() } },
			})
			const { jsonDescriptor } = generateProtoDefinitions(schema)
			const kora = (jsonDescriptor.nested as Record<string, Record<string, unknown>>).kora
			const messages = kora.nested as Record<string, unknown>

			expect(messages).toHaveProperty('KoraOperation')
			const op = messages.KoraOperation as Record<string, unknown>
			const fields = op.fields as Record<string, Record<string, unknown>>

			expect(fields.id.type).toBe('string')
			expect(fields.node_id.type).toBe('string')
			expect(fields.data.type).toBe('bytes')
			expect(fields.wall_time.type).toBe('int64')
			expect(fields.causal_deps.rule).toBe('repeated')
		})

		test('includes OperationBatch in descriptor', () => {
			const schema = schemaWith({
				items: { fields: { name: t.string() } },
			})
			const { jsonDescriptor } = generateProtoDefinitions(schema)
			const kora = (jsonDescriptor.nested as Record<string, Record<string, unknown>>).kora
			const messages = kora.nested as Record<string, unknown>

			expect(messages).toHaveProperty('OperationBatch')
			const batch = messages.OperationBatch as Record<string, unknown>
			const fields = batch.fields as Record<string, Record<string, unknown>>

			expect(fields.operations.type).toBe('KoraOperation')
			expect(fields.operations.rule).toBe('repeated')
			expect(fields.is_final.type).toBe('bool')
		})

		test('includes HandshakeMessage in descriptor', () => {
			const schema = schemaWith({
				items: { fields: { name: t.string() } },
			})
			const { jsonDescriptor } = generateProtoDefinitions(schema)
			const kora = (jsonDescriptor.nested as Record<string, Record<string, unknown>>).kora
			const messages = kora.nested as Record<string, unknown>

			expect(messages).toHaveProperty('HandshakeMessage')
			const msg = messages.HandshakeMessage as Record<string, unknown>
			const fields = msg.fields as Record<string, Record<string, unknown>>

			expect(fields.version_vector.keyType).toBe('string')
			expect(fields.version_vector.type).toBe('int64')
			expect(fields.schema_version.type).toBe('int32')
			expect(fields.node_id.type).toBe('string')
		})

		test('includes HandshakeResponse in descriptor', () => {
			const schema = schemaWith({
				items: { fields: { name: t.string() } },
			})
			const { jsonDescriptor } = generateProtoDefinitions(schema)
			const kora = (jsonDescriptor.nested as Record<string, Record<string, unknown>>).kora
			const messages = kora.nested as Record<string, unknown>

			expect(messages).toHaveProperty('HandshakeResponse')
			const msg = messages.HandshakeResponse as Record<string, unknown>
			const fields = msg.fields as Record<string, Record<string, unknown>>

			expect(fields.version_vector.keyType).toBe('string')
			expect(fields.schema_version.type).toBe('int32')
		})

		test('includes Acknowledgment in descriptor', () => {
			const schema = schemaWith({
				items: { fields: { name: t.string() } },
			})
			const { jsonDescriptor } = generateProtoDefinitions(schema)
			const kora = (jsonDescriptor.nested as Record<string, Record<string, unknown>>).kora
			const messages = kora.nested as Record<string, unknown>

			expect(messages).toHaveProperty('Acknowledgment')
			const msg = messages.Acknowledgment as Record<string, unknown>
			const fields = msg.fields as Record<string, Record<string, unknown>>

			expect(fields.sequence_number.type).toBe('int64')
			expect(fields.node_id.type).toBe('string')
		})

		test('enum fields produce nested enum values in descriptor', () => {
			const schema = schemaWith({
				tasks: {
					fields: {
						priority: t.enum(['low', 'high']),
					},
				},
			})
			const { jsonDescriptor } = generateProtoDefinitions(schema)
			const kora = (jsonDescriptor.nested as Record<string, Record<string, unknown>>).kora
			const messages = kora.nested as Record<string, unknown>

			const tasksRecord = messages.TasksRecord as Record<string, unknown>
			expect(tasksRecord).toHaveProperty('nested')

			const nested = tasksRecord.nested as Record<string, Record<string, unknown>>
			expect(nested).toHaveProperty('TasksRecordPriority')

			const enumDef = nested.TasksRecordPriority
			expect(enumDef.values).toEqual({
				TASKSRECORDPRIORITY_UNSPECIFIED: 0,
				TASKSRECORDPRIORITY_LOW: 1,
				TASKSRECORDPRIORITY_HIGH: 2,
			})
		})

		test('array fields have rule: repeated in descriptor', () => {
			const schema = schemaWith({
				items: { fields: { tags: t.array(t.string()) } },
			})
			const { jsonDescriptor } = generateProtoDefinitions(schema)
			const kora = (jsonDescriptor.nested as Record<string, Record<string, unknown>>).kora
			const messages = kora.nested as Record<string, unknown>

			const itemsRecord = messages.ItemsRecord as Record<string, unknown>
			const fields = itemsRecord.fields as Record<string, Record<string, unknown>>

			expect(fields.tags.type).toBe('string')
			expect(fields.tags.rule).toBe('repeated')
		})
	})

	// ──────────────────────────────────────────────────────────
	// Complex schema
	// ──────────────────────────────────────────────────────────

	describe('complex schema', () => {
		test('handles a full real-world schema', () => {
			const schema = defineSchema({
				version: 3,
				collections: {
					todos: {
						fields: {
							title: t.string(),
							completed: t.boolean().default(false),
							assignee: t.string().optional(),
							tags: t.array(t.string()).default([]),
							notes: t.richtext(),
							priority: t.enum(['low', 'medium', 'high']).default('medium'),
							dueDate: t.timestamp().optional(),
							createdAt: t.timestamp().auto(),
						},
						indexes: ['assignee', 'completed', 'dueDate'],
					},
					projects: {
						fields: {
							name: t.string(),
							description: t.string().optional(),
							active: t.boolean().default(true),
						},
					},
				},
				relations: {
					todoBelongsToProject: {
						from: 'todos',
						to: 'projects',
						type: 'many-to-one',
						field: 'assignee',
						onDelete: 'set-null',
					},
				},
			})

			const result = generateProtoDefinitions(schema)

			// Verify proto text structure
			expect(result.proto).toContain('syntax = "proto3";')
			expect(result.proto).toContain('package kora;')
			expect(result.proto).toContain('message TodosRecord {')
			expect(result.proto).toContain('message ProjectsRecord {')
			expect(result.proto).toContain('message KoraOperation {')

			// Verify all todo fields
			expect(result.typeMap.get('todos.id')).toBe('string')
			expect(result.typeMap.get('todos.title')).toBe('string')
			expect(result.typeMap.get('todos.completed')).toBe('bool')
			expect(result.typeMap.get('todos.assignee')).toBe('string')
			expect(result.typeMap.get('todos.tags')).toBe('repeated string')
			expect(result.typeMap.get('todos.notes')).toBe('bytes')
			expect(result.typeMap.get('todos.priority')).toBe('TodosRecordPriority')
			expect(result.typeMap.get('todos.dueDate')).toBe('int64')
			expect(result.typeMap.get('todos.createdAt')).toBe('int64')

			// Verify project fields
			expect(result.typeMap.get('projects.id')).toBe('string')
			expect(result.typeMap.get('projects.name')).toBe('string')
			expect(result.typeMap.get('projects.description')).toBe('string')
			expect(result.typeMap.get('projects.active')).toBe('bool')

			// Verify JSON descriptor is valid structure
			expect(result.jsonDescriptor).toHaveProperty('nested.kora.nested')
		})
	})

	// ──────────────────────────────────────────────────────────
	// Edge cases
	// ──────────────────────────────────────────────────────────

	describe('edge cases', () => {
		test('schema with single field collection', () => {
			const schema = schemaWith({
				minimal: { fields: { value: t.string() } },
			})
			const result = generateProtoDefinitions(schema)

			expect(result.proto).toContain('message MinimalRecord {')
			expect(result.proto).toContain('string id = 1;')
			expect(result.proto).toContain('string value = 2;')
			expect(result.typeMap.size).toBeGreaterThanOrEqual(2) // id + value
		})

		test('schema with many field types exercises all mappings', () => {
			const schema = schemaWith({
				everything: {
					fields: {
						aString: t.string(),
						aNumber: t.number(),
						aBool: t.boolean(),
						aTimestamp: t.timestamp(),
						aRichtext: t.richtext(),
						anEnum: t.enum(['a', 'b']),
						anArray: t.array(t.number()),
					},
				},
			})
			const result = generateProtoDefinitions(schema)

			expect(result.typeMap.get('everything.aString')).toBe('string')
			expect(result.typeMap.get('everything.aNumber')).toBe('double')
			expect(result.typeMap.get('everything.aBool')).toBe('bool')
			expect(result.typeMap.get('everything.aTimestamp')).toBe('int64')
			expect(result.typeMap.get('everything.aRichtext')).toBe('bytes')
			expect(result.typeMap.get('everything.anEnum')).toBe('EverythingRecordAnEnum')
			expect(result.typeMap.get('everything.anArray')).toBe('repeated double')
		})

		test('optional and default fields generate same proto types as required fields', () => {
			const schema = schemaWith({
				items: {
					fields: {
						required: t.string(),
						optional: t.string().optional(),
						defaulted: t.string().default('hello'),
					},
				},
			})
			const result = generateProtoDefinitions(schema)

			// Proto3 does not distinguish optional/required at the field type level
			expect(result.typeMap.get('items.required')).toBe('string')
			expect(result.typeMap.get('items.optional')).toBe('string')
			expect(result.typeMap.get('items.defaulted')).toBe('string')
		})

		test('auto fields generate same proto types', () => {
			const schema = schemaWith({
				items: {
					fields: {
						createdAt: t.timestamp().auto(),
					},
				},
			})
			const result = generateProtoDefinitions(schema)
			expect(result.typeMap.get('items.createdAt')).toBe('int64')
		})

		test('output proto ends with a newline', () => {
			const schema = schemaWith({
				items: { fields: { name: t.string() } },
			})
			const { proto } = generateProtoDefinitions(schema)
			expect(proto.endsWith('\n')).toBe(true)
		})

		test('collection and sync messages are in separate sections', () => {
			const schema = schemaWith({
				items: { fields: { name: t.string() } },
			})
			const { proto } = generateProtoDefinitions(schema)

			expect(proto).toContain('// Collection record messages')
			expect(proto).toContain('// Sync protocol messages')

			// Collection messages come before sync protocol messages
			const collectionIdx = proto.indexOf('// Collection record messages')
			const syncIdx = proto.indexOf('// Sync protocol messages')
			expect(collectionIdx).toBeLessThan(syncIdx)
		})
	})

	// ──────────────────────────────────────────────────────────
	// Return type contract
	// ──────────────────────────────────────────────────────────

	describe('return type contract', () => {
		test('returns proto as a string', () => {
			const schema = schemaWith({
				items: { fields: { name: t.string() } },
			})
			const result = generateProtoDefinitions(schema)
			expect(typeof result.proto).toBe('string')
		})

		test('returns typeMap as a Map', () => {
			const schema = schemaWith({
				items: { fields: { name: t.string() } },
			})
			const result = generateProtoDefinitions(schema)
			expect(result.typeMap).toBeInstanceOf(Map)
		})

		test('returns jsonDescriptor as a plain object', () => {
			const schema = schemaWith({
				items: { fields: { name: t.string() } },
			})
			const result = generateProtoDefinitions(schema)
			expect(typeof result.jsonDescriptor).toBe('object')
			expect(result.jsonDescriptor).not.toBeNull()
		})

		test('jsonDescriptor is JSON-serializable', () => {
			const schema = schemaWith({
				tasks: {
					fields: {
						title: t.string(),
						priority: t.enum(['low', 'high']),
						tags: t.array(t.string()),
					},
				},
			})
			const { jsonDescriptor } = generateProtoDefinitions(schema)

			// Should not throw
			const json = JSON.stringify(jsonDescriptor)
			const parsed = JSON.parse(json) as Record<string, unknown>
			expect(parsed).toEqual(jsonDescriptor)
		})
	})

	// ──────────────────────────────────────────────────────────
	// Snake case conversion
	// ──────────────────────────────────────────────────────────

	describe('snake_case conversion', () => {
		test('multi-capital sequences are converted correctly', () => {
			const schema = schemaWith({
				items: {
					fields: {
						firstName: t.string(),
						createdAt: t.timestamp(),
						isEmailVerified: t.boolean(),
					},
				},
			})
			const { proto } = generateProtoDefinitions(schema)
			expect(proto).toContain('first_name')
			expect(proto).toContain('created_at')
			expect(proto).toContain('is_email_verified')
		})

		test('already snake_case field names are unchanged', () => {
			const schema = schemaWith({
				items: { fields: { name: t.string() } },
			})
			const { proto } = generateProtoDefinitions(schema)
			expect(proto).toContain('string name = 2;')
		})
	})

	// ──────────────────────────────────────────────────────────
	// Multiple enum fields
	// ──────────────────────────────────────────────────────────

	describe('multiple enums in same collection', () => {
		test('generates distinct enum types per field', () => {
			const schema = schemaWith({
				tasks: {
					fields: {
						priority: t.enum(['low', 'high']),
						status: t.enum(['open', 'closed', 'archived']),
					},
				},
			})
			const { proto, typeMap } = generateProtoDefinitions(schema)

			expect(proto).toContain('enum TasksRecordPriority {')
			expect(proto).toContain('enum TasksRecordStatus {')
			expect(typeMap.get('tasks.priority')).toBe('TasksRecordPriority')
			expect(typeMap.get('tasks.status')).toBe('TasksRecordStatus')
		})
	})

	// ──────────────────────────────────────────────────────────
	// JSON descriptor completeness
	// ──────────────────────────────────────────────────────────

	describe('JSON descriptor field ID consistency', () => {
		test('field IDs in descriptor match field numbers in proto text', () => {
			const schema = schemaWith({
				items: {
					fields: {
						title: t.string(),
						count: t.number(),
						active: t.boolean(),
					},
				},
			})
			const { jsonDescriptor } = generateProtoDefinitions(schema)
			const kora = (jsonDescriptor.nested as Record<string, Record<string, unknown>>).kora
			const messages = kora.nested as Record<string, unknown>
			const itemsRecord = messages.ItemsRecord as Record<string, unknown>
			const fields = itemsRecord.fields as Record<string, Record<string, unknown>>

			expect(fields.id.id).toBe(1)
			expect(fields.title.id).toBe(2)
			expect(fields.count.id).toBe(3)
			expect(fields.active.id).toBe(4)
		})
	})
})
