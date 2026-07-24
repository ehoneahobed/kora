import type { Operation } from '@korajs/core'
import type { ProductionHttpRouteContext } from '../server/route-context'
import type { AuthContext } from '../types'

/**
 * What the server hands an operation validator so it can adjudicate an untrusted
 * client operation before that operation becomes authoritative.
 *
 * The validator is POLICY (yours); the framework owns the MECHANISM around it —
 * running it at ingestion, and routing its decision deterministically.
 */
export interface OperationValidationContext {
	/**
	 * The authenticated actor for the submitting session, or `null` for an
	 * anonymous / unauthenticated connection. This is how a public submission
	 * endpoint tells "signed-in owner" from "anonymous respondent" apart.
	 */
	auth: AuthContext | null
	/**
	 * Trusted, scoped data-plane access — the same context available as
	 * `server.kora` / `request.kora`. Use `kora.query` / `kora.findById` to read
	 * current authoritative state while deciding, and `kora.apply` to AUTHOR a
	 * derived server operation (for example promoting a validated anonymous
	 * submission into an owner-visible collection). Authoring a new operation is
	 * always preferred over mutating the incoming one, which must stay immutable
	 * so content-addressing and convergence hold.
	 */
	kora: ProductionHttpRouteContext
}

/**
 * The verdict a validator returns for one incoming operation.
 *
 * - `accept` — let the operation materialize on the server as-is and relay to
 *   connected clients, exactly as an untrusted op would flow without a validator.
 * - `reject` — refuse it. The operation never enters the authoritative log, so no
 *   other replica ever sees it; a structured rejection travels back to the
 *   submitter tied to the operation id, and the submitter keeps the op in a
 *   durable rejected store (recoverable and explainable) rather than losing it or
 *   retrying forever. `retriable` defaults from the shared taxonomy for the code.
 * - `ignore` — the server takes responsibility for the operation out of band (for
 *   example the validator already authored a derived op via `context.kora`) and
 *   does not want the raw incoming op materialized. No rejection is sent, so the
 *   submitter treats it as handled and drops it from its pending queue.
 */
export type OperationDecision =
	| { action: 'accept' }
	| { action: 'reject'; code: string; message: string; retriable?: boolean }
	| { action: 'ignore' }

/**
 * An app-provided function that adjudicates an untrusted client operation at sync
 * ingestion, after HLC ordering and the built-in guards (timestamp, rate, size),
 * and before the operation is materialized into authoritative state.
 */
export type OperationValidator = (
	operation: Operation,
	context: OperationValidationContext,
) => Promise<OperationDecision> | OperationDecision
