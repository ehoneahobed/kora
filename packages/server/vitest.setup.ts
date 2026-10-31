import { registerAccessCompiler } from '@korajs/core'

// Tests read `schema.access` directly. A production browser bundle defers the access
// compiler until the Kora runtime loads; these environments always have it.
registerAccessCompiler()
