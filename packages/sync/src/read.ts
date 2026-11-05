// The read-through client (first-visit parity, S4b): a separate entry so that loading it does not
// pull it into `lite`, which the first paint imports as a whole module namespace.

export { ReadThroughClient, ReadThroughError } from './read/read-through-client'
export type {
	ReadAnswer,
	ReadCallOptions,
	ReadFetch,
	ReadFetchInit,
	ReadFetchResponse,
	ReadThroughClientOptions,
} from './read/read-through-client'
export type { ReadQuery, ReadRecord, ReadResult } from './read/read-types'
