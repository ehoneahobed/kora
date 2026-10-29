import type { Codemod, CodemodFinding } from './types'

const DOCS = 'https://korajs.dev/guide/upgrading-to-beta13'

const REMOVED = /\bDynamicProtobufSerializer\b/
const OPT_IN = /\b(ProtobufMessageSerializer|NegotiatedMessageSerializer)\b/
const IMPORT_OR_EXPORT_LINE = /^\s*(?:import|export)\b/
const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/

/**
 * Wire serialization changed in 1.0.0-beta.13 (SYNC-9, NEW-DX-2): clients and servers speak
 * JSON; protobuf is no longer negotiated, so `ProtobufMessageSerializer` is something both
 * ends of a transport you control must opt into, and `DynamicProtobufSerializer` is gone.
 *
 * Report-only: whether to drop protobuf or to configure both ends depends on the deployment,
 * which source analysis cannot know.
 */
export const protobufSerializerCodemod: Codemod = {
	id: 'wire-format-serializers',
	title: 'Wire format: JSON by default, protobuf is an explicit opt-in on both ends',
	introducedIn: '1.0.0-beta.13',
	docs: DOCS,
	run({ files }) {
		const findings: CodemodFinding[] = []
		for (const file of files) {
			if (!file.text.includes('Protobuf') && !file.text.includes('NegotiatedMessageSerializer')) {
				continue
			}
			for (const [index, line] of file.text.split('\n').entries()) {
				if (IMPORT_OR_EXPORT_LINE.test(line) || COMMENT_LINE.test(line)) continue
				if (REMOVED.test(line)) {
					findings.push({
						file: file.path,
						line: index + 1,
						severity: 'warn',
						message:
							'DynamicProtobufSerializer was removed in beta.13. Delete the serializer option and use the default JSON wire format.',
					})
					continue
				}
				const match = OPT_IN.exec(line)
				if (match) {
					findings.push({
						file: file.path,
						line: index + 1,
						severity: 'warn',
						message: `${match[1]} is no longer negotiated: Kora clients and servers speak JSON, so sync fails unless both ends of this transport use the same serializer. Remove it unless you control both ends and need protobuf.`,
					})
				}
			}
		}
		return { findings, edits: [] }
	},
}
