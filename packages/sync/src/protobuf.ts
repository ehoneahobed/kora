// Opt-in protobuf wire format. Importing this entry is the explicit choice to use protobufjs;
// the default `@korajs/sync` import graph reaches it only through tree-shaken re-exports.
export {
	NegotiatedMessageSerializer,
	ProtobufMessageSerializer,
} from './protocol/protobuf-serializer'
