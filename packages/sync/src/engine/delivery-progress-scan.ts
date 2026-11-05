/**
 * A syntax-tree scan of the sync engine's source for who writes the delivery position
 * (docs/design/first-visit-parity.md, S3 review round 6). Test support only: it is not exported
 * from the package and nothing at runtime imports it.
 *
 * Four review rounds found the same bug class four times: a write of the position after an
 * await with no re-check that the position the batch was received at still exists. Round 5 made
 * `commitDeliveryProgress` the one writer and guarded it with a line-regex lint; the fifth
 * review defeated that lint with eight escapes (bracket access, compound assignment, optional
 * call, destructured alias, a generic method name, an arrow-property member, a variable second
 * argument, `const self = this`). This scan reads the syntax tree instead, so none of those
 * spellings is a different thing to it: it reports every place the engine writes, aliases or
 * names a protected field or persistence method, and every mutation of the live database that a
 * stale batch could reach without a synchronous position check before it.
 */
import ts from 'typescript'

/**
 * Names the delivery position used to have as engine fields. It lives in `DeliveryPosition`
 * now (private state), so any assignment to one of these names is a regression to fields.
 */
export const POSITION_FIELDS = ['deliveryWatermark', 'accessRulesKey'] as const

/** Engine state whose writes decide what a batch counts for: each write is listed with its owner. */
export const STATE_FIELDS = [
	'staging',
	'principal',
	'sessionPrincipal',
	'deliveryGeneration',
	'sessionEpoch',
	'connectionGeneration',
	'offlineWatermarks',
	'serverFrontier',
	'position',
] as const

/** Fields of a delivery context / replica that decide what a batch counts for; writing one rewrites the check. */
export const CONTEXT_FIELDS = [
	'watermark',
	'signature',
	'generation',
	'epoch',
	'connection',
	'rulesKey',
] as const

/** Methods that change the collection they are called on (a Map, Set or array held in engine state). */
const MUTATING_METHODS = new Set([
	'set',
	'delete',
	'clear',
	'add',
	'push',
	'pop',
	'shift',
	'unshift',
	'splice',
	'sort',
	'reverse',
	'fill',
	'copyWithin',
])

/** Engine state that is a collection: handing out the collection itself hands out the right to change it. */
const COLLECTION_STATE = ['offlineWatermarks'] as const

/** Methods of `DeliveryPosition` that change it (owners), and the writer's. */
export const POSITION_MUTATORS = [
	'moveTo',
	'adoptRulesKey',
	'recordView',
	'preloadView',
	'forgetView',
	'advance',
	'adoptKey',
] as const

/**
 * Calls that must be serialized with batch handling (every caller runs inside the message chain,
 * or after awaiting it): each caller is pinned, so a new one is a reviewed decision.
 */
export const SERIALIZED_ONLY = ['resetDeliveryForFullResync'] as const

/** `Object` statics that cannot write to an object they are given. */
const SAFE_OBJECT_STATICS = new Set([
	'keys',
	'entries',
	'values',
	'fromEntries',
	'freeze',
	'getPrototypeOf',
	'getOwnPropertyNames',
	'is',
	'create',
])

/** Methods that write the delivery position durably or tell the server about it. */
export const PERSISTENCE_METHODS = [
	'saveDeliveryWatermark',
	'setViewWatermark',
	'persistDeliveryWatermark',
	'saveAccessRulesKey',
	'saveUnappliedOperationsInTx',
	'sendDeliveryAck',
] as const

/** Methods that mutate the live database on the strength of a delivered batch. */
export const BATCH_MUTATIONS = [
	'applyCollectionNarrowing',
	'applyDeliveredRetraction',
	'applyScopeRetraction',
	'deferScopeRetraction',
	'recheckAccessNarrowing',
	'applyInbound',
	'rebaseDeliveryRun',
	'openOfflineUnit',
	'ensureOfflineUnit',
	'clearOfflineMarks',
	// Store-level writers of a delivered operation, a narrowing and a whole batch: reached from the
	// engine only through the methods above, or listed (with the reason) in the table of the test.
	'applyAtPosition',
	'applyRemoteOperation',
	'applyScopeNarrowing',
	'applyDeliveryBatch',
] as const

/**
 * Mutations that carry their own currency check into the storage transaction (the synchronous
 * guard before them cannot cover the wait for the database): a call must pass the delivery
 * context or an `isCurrent` callback, so the store checks again as the first statement of its own
 * write. A call without one is a finding (`uncarried:`) listed with its reason.
 */
export const CARRIES_CURRENCY = [
	'applyInbound',
	'applyAtPosition',
	'applyScopeRetraction',
	'applyCollectionNarrowing',
	'deferScopeRetraction',
	'applyDeliveredRetraction',
] as const

/** Protected names that must never be spelled as a string the scan reads as data (defineProperty, Reflect, ...). */
const PROTECTED_NAMES: readonly string[] = [
	'moved',
	'positionMoved',
	'deliveryContextChanged',
	'deliveryWatermark',
	'accessRulesKey',
	'delivery_watermark',
]

/** Calls that, made synchronously, tell a caller the position its batch was received at moved. */
export const GUARDS = ['moved', 'positionMoved', 'deliveryContextChanged'] as const

/** One finding of the scan. */
export interface Site {
	/** The file the finding is in. */
	file: string
	/** What was found, e.g. `assign:deliveryWatermark` or `unguarded:ensureOfflineUnit`. */
	rule: string
	/** The class member that contains it, e.g. `SyncEngine.startInternal`. */
	member: string
	line: number
	text: string
}

const ASSIGNMENT_OPERATORS = new Set<ts.SyntaxKind>([
	ts.SyntaxKind.EqualsToken,
	ts.SyntaxKind.PlusEqualsToken,
	ts.SyntaxKind.MinusEqualsToken,
	ts.SyntaxKind.AsteriskEqualsToken,
	ts.SyntaxKind.SlashEqualsToken,
	ts.SyntaxKind.PercentEqualsToken,
	ts.SyntaxKind.AsteriskAsteriskEqualsToken,
	ts.SyntaxKind.LessThanLessThanEqualsToken,
	ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
	ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
	ts.SyntaxKind.AmpersandEqualsToken,
	ts.SyntaxKind.BarEqualsToken,
	ts.SyntaxKind.CaretEqualsToken,
	ts.SyntaxKind.BarBarEqualsToken,
	ts.SyntaxKind.AmpersandAmpersandEqualsToken,
	ts.SyntaxKind.QuestionQuestionEqualsToken,
])

/** The name an access expression reaches: `a.b`, `a?.b`, `a['b']` and `` a[`b`] `` all say `b`. */
function accessedName(node: ts.Node): string | null {
	if (ts.isPropertyAccessExpression(node)) return node.name.text
	if (ts.isElementAccessExpression(node)) {
		const argument = node.argumentExpression
		if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
			return argument.text
		}
	}
	return null
}

/**
 * The name a property key spells: `a`, `'a'`, `` `a` ``, `['a']`; `'dynamic'` for a computed key the
 * scan cannot read (`[k]`, `['a' + 'b']`).
 */
function keyName(key: ts.PropertyName): string {
	if (ts.isIdentifier(key) || ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) {
		return key.text
	}
	if (ts.isNumericLiteral(key)) return key.text
	if (ts.isComputedPropertyName(key)) {
		const inner = key.expression
		if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return inner.text
	}
	return 'dynamic'
}

/** Whether `node` is written to: an assignment target (also inside a destructuring pattern), `++`, `--`, `delete`. */
function isWriteTarget(node: ts.Node): boolean {
	let child: ts.Node = node
	let parent = node.parent
	// Through parentheses, `as`, `!` and the pieces of a destructuring assignment.
	while (
		parent !== undefined &&
		(ts.isParenthesizedExpression(parent) ||
			ts.isAsExpression(parent) ||
			ts.isNonNullExpression(parent) ||
			ts.isSatisfiesExpression(parent) ||
			ts.isArrayLiteralExpression(parent) ||
			ts.isSpreadElement(parent) ||
			ts.isShorthandPropertyAssignment(parent) ||
			(ts.isPropertyAssignment(parent) && parent.initializer === child) ||
			ts.isObjectLiteralExpression(parent))
	) {
		child = parent
		parent = parent.parent
	}
	if (parent === undefined) return false
	if (ts.isBinaryExpression(parent)) {
		return ASSIGNMENT_OPERATORS.has(parent.operatorToken.kind) && parent.left === child
	}
	if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) {
		return (
			parent.operator === ts.SyntaxKind.PlusPlusToken ||
			parent.operator === ts.SyntaxKind.MinusMinusToken
		)
	}
	if (ts.isDeleteExpression(parent)) return true
	// `for (this.x of ...)`
	if (
		(ts.isForOfStatement(parent) || ts.isForInStatement(parent)) &&
		parent.initializer === child
	) {
		return true
	}
	return false
}

function memberOf(node: ts.Node): string {
	for (let current: ts.Node | undefined = node; current; current = current.parent) {
		if (
			ts.isMethodDeclaration(current) ||
			ts.isPropertyDeclaration(current) ||
			ts.isGetAccessorDeclaration(current) ||
			ts.isSetAccessorDeclaration(current) ||
			ts.isConstructorDeclaration(current)
		) {
			const owner = current.parent
			const className =
				ts.isClassDeclaration(owner) && owner.name !== undefined ? owner.name.text : '<class>'
			const name = ts.isConstructorDeclaration(current)
				? 'constructor'
				: current.name.getText(current.getSourceFile())
			return className === 'SyncEngine' ? `SyncEngine.${name}` : `${className}.${name}`
		}
		if (ts.isFunctionDeclaration(current) && current.name !== undefined) {
			return `function ${current.name.text}`
		}
	}
	return '<top level>'
}

/** Whether `call` is `this.positionMoved(...)` / `this.deliveryContextChanged(...)`: the engine's own check. */
function isEngineCheck(call: ts.CallExpression): boolean {
	const callee = call.expression
	if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return false
	if (callee.expression.kind !== ts.SyntaxKind.ThisKeyword) return false
	const name = accessedName(callee)
	return name === 'positionMoved' || name === 'deliveryContextChanged'
}

/** The expression of an arrow function / function expression body that is just `return <expr>`, parentheses removed. */
function returnedExpression(fn: ts.Node): ts.Expression | null {
	if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return null
	let body: ts.Node | undefined = fn.body
	if (ts.isBlock(body)) {
		if (body.statements.length !== 1) return null
		const only = body.statements[0]
		if (only === undefined || !ts.isReturnStatement(only) || only.expression === undefined) {
			return null
		}
		body = only.expression
	}
	while (ts.isParenthesizedExpression(body)) body = body.expression
	return body as ts.Expression
}

/**
 * Whether `name(...)` called from `from` is a check: a local declared in an enclosing function as a
 * function whose whole body is the engine's check (`const moved = () => this.positionMoved(context)`).
 * A local of the same name that returns something else (`() => false`), a parameter or a free name is not.
 */
function isLocalCheck(name: string, from: ts.Node): boolean {
	for (let scope: ts.Node | undefined = from.parent; scope; scope = scope.parent) {
		const statements = ts.isBlock(scope) || ts.isSourceFile(scope) ? scope.statements : undefined
		if (statements === undefined) continue
		for (const statement of statements) {
			if (!ts.isVariableStatement(statement)) continue
			for (const declaration of statement.declarationList.declarations) {
				if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue
				const init = declaration.initializer
				const body = init === undefined ? null : returnedExpression(init)
				return body !== null && ts.isCallExpression(body) && isEngineCheck(body)
			}
		}
	}
	return false
}

/** A call that tells its caller, synchronously, that the position its batch was received at moved. */
function isGuardCall(call: ts.CallExpression): boolean {
	if (isEngineCheck(call)) return true
	const callee = call.expression
	return ts.isIdentifier(callee) && callee.text === 'moved' && isLocalCheck('moved', call)
}

/** Whether `condition` is true when the position moved: only `||` and parentheses lead to the check. */
function conditionSaysMoved(condition: ts.Expression): boolean {
	let node: ts.Expression = condition
	while (ts.isParenthesizedExpression(node)) node = node.expression
	if (ts.isCallExpression(node)) return isGuardCall(node)
	if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
		return conditionSaysMoved(node.left) || conditionSaysMoved(node.right)
	}
	return false
}

/** Whether a statement always leaves its block (return, throw, break, continue). */
function terminates(statement: ts.Statement): boolean {
	if (
		ts.isReturnStatement(statement) ||
		ts.isThrowStatement(statement) ||
		ts.isBreakStatement(statement) ||
		ts.isContinueStatement(statement)
	) {
		return true
	}
	if (ts.isBlock(statement)) {
		const last = statement.statements[statement.statements.length - 1]
		return last !== undefined && terminates(last)
	}
	return false
}

/** Whether `statement` is a gate: `if (<moved>) <leave>`, with no await anywhere in its condition. */
function isGate(statement: ts.Statement): boolean {
	return (
		ts.isIfStatement(statement) &&
		conditionSaysMoved(statement.expression) &&
		terminates(statement.thenStatement) &&
		!containsAwait(statement.expression)
	)
}

/** Whether `node` is, or contains outside of nested functions, a point where the function yields to the event loop. */
function containsAwait(node: ts.Node): boolean {
	let found = false
	const visit = (child: ts.Node): void => {
		if (found) return
		if (ts.isFunctionLike(child) && child !== node) return
		if (ts.isAwaitExpression(child) || ts.isYieldExpression(child)) found = true
		if (ts.isForOfStatement(child) && child.awaitModifier !== undefined) found = true
		ts.forEachChild(child, visit)
	}
	visit(node)
	return found
}

/** Whether `node` awaits something that does not contain `except` (the call being judged). */
function awaitsApartFrom(node: ts.Node, except: ts.Node): boolean {
	let found = false
	const visit = (child: ts.Node): void => {
		if (found || child === except) return
		if (ts.isFunctionLike(child) && child !== node) return
		if (
			(ts.isAwaitExpression(child) || ts.isYieldExpression(child)) &&
			!containsNode(child, except)
		) {
			found = true
		}
		if (ts.isForOfStatement(child) && child.awaitModifier !== undefined) found = true
		ts.forEachChild(child, visit)
	}
	visit(node)
	return found
}

function containsNode(outer: ts.Node, inner: ts.Node): boolean {
	return outer.pos <= inner.pos && inner.end <= outer.end
}

/**
 * Whether the statement holding `call` yields before the call runs: an `await` earlier in the same
 * statement or in the call's own arguments (an `await` that wraps the call runs after it).
 */
function awaitsBeforeInOwnStatement(call: ts.Node, statement: ts.Node): boolean {
	let found = false
	const visit = (child: ts.Node): void => {
		if (found) return
		if (ts.isFunctionLike(child) && child !== statement) return
		if (
			(ts.isAwaitExpression(child) || ts.isYieldExpression(child)) &&
			!containsNode(child, call) &&
			child.getStart() < call.end
		) {
			found = true
		}
		ts.forEachChild(child, visit)
	}
	visit(statement)
	return found
}

const LOOPS = [
	ts.SyntaxKind.ForStatement,
	ts.SyntaxKind.ForOfStatement,
	ts.SyntaxKind.ForInStatement,
	ts.SyntaxKind.WhileStatement,
	ts.SyntaxKind.DoStatement,
]

/**
 * Whether a gate (`if (<moved>) <leave>`) precedes `call` in its own function with nothing yielding
 * between the gate and the call: no await in a statement between them, none earlier in the call's own
 * statement or arguments, none in the condition of a branch that holds the call, and for a loop the
 * body carries its own gate (the previous iteration yielded). A mention of a check that is not a gate
 * (result ignored, in a branch that does not leave, in a loop of its own, a local that always says no)
 * does not count.
 */
function guardedBefore(call: ts.Node): boolean {
	let node: ts.Node = call
	let awaitedSince = false
	let ownStatement = true
	while (node.parent !== undefined) {
		const parent: ts.Node = node.parent
		if (ts.isFunctionLike(parent)) return false
		if (ts.isBlock(parent) || ts.isSourceFile(parent) || ts.isCaseClause(parent)) {
			// `node` is the statement that holds the call, in the innermost block.
			if (ownStatement && awaitsBeforeInOwnStatement(call, node)) awaitedSince = true
			ownStatement = false
			const statements: readonly ts.Statement[] = parent.statements
			const at = statements.indexOf(node as ts.Statement)
			for (let index = at - 1; index >= 0; index--) {
				const earlier = statements[index] as ts.Statement
				if (isGate(earlier)) return !awaitedSince
				if (awaitsApartFrom(earlier, call)) awaitedSince = true
			}
		}
		// A branch is reached after its condition was evaluated: an await there ran before the call.
		if (
			(ts.isIfStatement(parent) &&
				node !== parent.expression &&
				containsAwait(parent.expression)) ||
			(ts.isSwitchStatement(parent) &&
				node !== parent.expression &&
				containsAwait(parent.expression)) ||
			(ts.isTryStatement(parent) && node !== parent.tryBlock)
		) {
			awaitedSince = true
		}
		if (LOOPS.includes(parent.kind)) {
			// A gate before the loop does not cover a later iteration, unless the loop never yields.
			const loopBody =
				ts.isForStatement(parent) ||
				ts.isForOfStatement(parent) ||
				ts.isForInStatement(parent) ||
				ts.isWhileStatement(parent) ||
				ts.isDoStatement(parent)
					? parent.statement
					: parent
			if (awaitsApartFrom(loopBody, call) || containsAwait(parent)) {
				// The loop's own gate (inside the body, before the call) was handled by the block walk.
				return false
			}
		}
		node = parent
	}
	return false
}

/**
 * Whether a call hands the mutation a way to ask, inside its own write, whether the delivery still
 * stands: an argument that is (or contains) the delivery `context`, or an `isCurrent` callback.
 */
function passesCurrency(call: ts.CallExpression): boolean {
	return call.arguments.some((argument) => {
		const text = argument.getText()
		return /\bisCurrent\b|\bcontext\b/.test(text)
	})
}

/** Scans `source` (the text of a source file) and returns every finding. */
export function scanDeliveryPosition(source: string, fileName = 'sync-engine.ts'): Site[] {
	const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
	const sites: Site[] = []
	const add = (rule: string, node: ts.Node): void => {
		const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
		sites.push({
			file: fileName,
			rule,
			member: memberOf(node),
			line: line + 1,
			text: node.getText(file).slice(0, 90),
		})
	}
	const names = (list: readonly string[], name: string): boolean => list.includes(name)
	const checkBoundName = (text: string, at: ts.Node): void => {
		if (names(PERSISTENCE_METHODS, text)) add(`alias:${text}`, at)
		if (names(POSITION_MUTATORS, text) || text === 'writer') add(`alias:${text}`, at)
		if (names(BATCH_MUTATIONS, text)) add(`alias:${text}`, at)
		if (names(GUARDS, text) && text !== 'moved') add(`alias:${text}`, at)
		if (names(POSITION_FIELDS, text) && isWriteTarget(at)) add(`assign:${text}`, at)
	}
	const visit = (node: ts.Node): void => {
		const name = accessedName(node)
		if (name !== null) {
			if (names(POSITION_FIELDS, name) && isWriteTarget(node)) add(`assign:${name}`, node)
			if (names(STATE_FIELDS, name) && isWriteTarget(node)) add(`state:${name}`, node)
			if (names(PERSISTENCE_METHODS, name)) add(`persist:${name}`, node)
			if (names(POSITION_MUTATORS, name)) add(`position:${name}`, node)
			if (name === 'writer') add('position:writer', node)
			if (names(SERIALIZED_ONLY, name)) add(`serialized:${name}`, node)
			if (name === 'saveQuarantine') {
				// Only the one-argument form (memory-only rows) is not a write of a position.
				const parent = node.parent
				const plain =
					ts.isCallExpression(parent) &&
					parent.expression === node &&
					parent.arguments.length === 1 &&
					!ts.isSpreadElement(parent.arguments[0] as ts.Expression)
				if (!plain) add('persist:saveQuarantine-progress', node)
			}
			if (name === 'deliverySignatureWatermarks') add('cache:legacy-field', node)
			if (names(BATCH_MUTATIONS, name)) {
				const parent = node.parent
				const called = ts.isCallExpression(parent) && parent.expression === node
				if (!called) {
					// A mutator held as a value is called later, when no check precedes it.
					add(`reference:${name}`, node)
				} else {
					if (!guardedBefore(parent)) add(`unguarded:${name}`, node)
					if (names(CARRIES_CURRENCY, name) && !passesCurrency(parent)) {
						add(`uncarried:${name}`, node)
					}
				}
			}
			if (names(CONTEXT_FIELDS, name) && isWriteTarget(node)) add(`state:context.${name}`, node)
			// Changing the collection a state field holds is writing the state.
			if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
				const receiver = accessedName(node.expression)
				if (receiver !== null && names(STATE_FIELDS, receiver) && MUTATING_METHODS.has(name)) {
					add(`state:${receiver}.${name}`, node)
				}
			}
			if (names(COLLECTION_STATE, name)) {
				const parent = node.parent
				const read =
					(ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
					parent.expression === node
				if (!read && !isWriteTarget(node)) add(`state-alias:${name}`, node)
			}
			// The checks themselves: replaced, deleted, redefined, or declared again by a subclass.
			if (names(GUARDS, name) && isWriteTarget(node)) add(`tamper:${name}`, node)
		}
		if (
			(ts.isMethodDeclaration(node) ||
				ts.isPropertyDeclaration(node) ||
				ts.isGetAccessorDeclaration(node) ||
				ts.isSetAccessorDeclaration(node)) &&
			names(
				GUARDS,
				ts.isComputedPropertyName(node.name) ? keyName(node.name) : node.name.getText(file),
			)
		) {
			add(`tamper:declare:${node.name.getText(file)}`, node)
		}
		// A name given as a string is a spelling of the member for `defineProperty`, `Reflect` and friends.
		if (
			(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
			!ts.isElementAccessExpression(node.parent) &&
			!ts.isImportDeclaration(node.parent) &&
			!ts.isExportDeclaration(node.parent) &&
			!ts.isLiteralTypeNode(node.parent) &&
			!ts.isComputedPropertyName(node.parent) &&
			!ts.isBindingElement(node.parent)
		) {
			if (PROTECTED_NAMES.includes(node.text)) add(`named-by-string:${node.text}`, node)
			// The durable position, reached by its key (raw SQL, a meta write) instead of its writer.
			if (/delivery_watermark/.test(node.text)) add('sql:delivery-watermark', node)
		}
		if (ts.isTemplateExpression(node) && /delivery_watermark/.test(node.head.text)) {
			add('sql:delivery-watermark', node)
		}
		if (
			ts.isIdentifier(node) &&
			node.text === 'DELIVERY_WATERMARK_META_KEY' &&
			!ts.isImportSpecifier(node.parent)
		) {
			add('sql:delivery-watermark', node)
		}
		// Code built at run time reaches every member by any name.
		if (ts.isIdentifier(node) && node.text === 'eval') add('dynamic-code:eval', node)
		if (
			ts.isIdentifier(node) &&
			node.text === 'Function' &&
			(ts.isNewExpression(node.parent) || ts.isCallExpression(node.parent)) &&
			node.parent.expression === node
		) {
			add('dynamic-code:Function', node)
		}
		if (
			ts.isCallExpression(node) &&
			accessedName(node.expression) === 'constructor' &&
			node.arguments.length > 0
		) {
			add('dynamic-code:constructor', node)
		}
		if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) && node.expression.text === 'require'))
		) {
			add('dynamic-import', node)
		}
		if (ts.isBindingElement(node) && node.propertyName !== undefined) {
			// `{ ['moveTo']: m }`, `{ 'moveTo': m }`: the key is a spelling of the member.
			const key = keyName(node.propertyName)
			if (key === 'dynamic') {
				add('dynamic-member-access', node)
			} else if (!ts.isIdentifier(node.propertyName)) {
				checkBoundName(key, node)
			}
		}
		if (ts.isIdentifier(node)) {
			// A name reached without a property access: a shorthand `{ saveDeliveryWatermark }`
			// or a destructured alias `const { saveDeliveryWatermark: save } = this.syncState`.
			const parent = node.parent
			const isBinding =
				ts.isBindingElement(parent) &&
				(parent.propertyName === undefined ? parent.name === node : parent.propertyName === node)
			const isShorthand = ts.isShorthandPropertyAssignment(parent) && parent.name === node
			if (isBinding || isShorthand) checkBoundName(node.text, node)
			// Reflection and aliases of the global objects that write through them.
			if (node.text === 'Reflect' || node.text === 'globalThis' || node.text === 'Proxy')
				add(`reflective:${node.text}`, node)
			if (node.text === 'Object') {
				const access = node.parent
				const safe =
					ts.isPropertyAccessExpression(access) &&
					access.expression === node &&
					SAFE_OBJECT_STATICS.has(access.name.text)
				if (!safe && !ts.isPropertyAccessExpression(access)) add('reflective:Object-alias', node)
				if (!safe && ts.isPropertyAccessExpression(access))
					add(`reflective:Object.${access.name.text}`, node)
				if (ts.isElementAccessExpression(access)) add('reflective:Object[...]', node)
			}
		}
		// A key the scan cannot read reaches any member (the hole behind every bracket spelling).
		if (ts.isElementAccessExpression(node) && accessedName(node) === null) {
			add('dynamic-member-access', node)
		}
		// `const self = this` / `self = this`: the engine is then reachable under another name.
		if (
			(ts.isVariableDeclaration(node) &&
				node.initializer !== undefined &&
				node.initializer.kind === ts.SyntaxKind.ThisKeyword) ||
			(ts.isBinaryExpression(node) &&
				node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
				node.right.kind === ts.SyntaxKind.ThisKeyword)
		) {
			add('alias-this', node)
		}
		// A cast is how `as any` opens a typed member to a spelling the compiler would refuse.
		if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
			const inner = node.expression.getText(file)
			if (/\bthis\b|syncState|\bstore\b|position/.test(inner)) add('cast-of-guarded', node)
		}
		if (ts.isImportDeclaration(node)) {
			const clause = node.importClause?.getText(file) ?? ''
			// `import * as S` reaches every export, including the ones named only by a variable later.
			if (
				node.importClause?.namedBindings &&
				ts.isNamespaceImport(node.importClause.namedBindings)
			) {
				add('import:namespace', node)
			}
			if (/DeliveryPosition|PositionWriter/.test(clause)) add('import:position', node)
			// A persistence writer imported as a free function (not a member the rules above see).
			for (const writer of PERSISTENCE_METHODS) {
				if (new RegExp(`\\b${writer}\\b`).test(clause)) add(`import:${writer}`, node)
			}
		}
		// A free function by that name used in any way (called, passed, returned, assigned), whatever
		// it was imported as. Member names and declarations are the other rules' or are not uses.
		if (ts.isIdentifier(node) && names(PERSISTENCE_METHODS, node.text)) {
			const parent = node.parent
			const isName =
				(ts.isPropertyAccessExpression(parent) ||
					ts.isPropertyAssignment(parent) ||
					ts.isMethodDeclaration(parent) ||
					ts.isPropertyDeclaration(parent) ||
					ts.isMethodSignature(parent) ||
					ts.isPropertySignature(parent) ||
					ts.isGetAccessor(parent) ||
					ts.isSetAccessor(parent) ||
					ts.isFunctionDeclaration(parent) ||
					ts.isParameter(parent) ||
					ts.isBindingElement(parent) ||
					ts.isShorthandPropertyAssignment(parent) ||
					ts.isImportSpecifier(parent) ||
					ts.isExportSpecifier(parent) ||
					ts.isImportClause(parent)) &&
				(parent as ts.NamedDeclaration).name === node
			const isPropertyKey = ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)
			if (!isName && !isPropertyKey) add(`call:${node.text}`, node)
		}
		ts.forEachChild(node, visit)
	}
	visit(file)
	return sites
}

/** Findings as `rule @ file @ member` counted, the form the allowlist is written in. */
export function tally(sites: Site[]): Record<string, number> {
	const counts: Record<string, number> = {}
	for (const site of sites) {
		const key = `${site.rule} @ ${site.file} @ ${site.member}`
		counts[key] = (counts[key] ?? 0) + 1
	}
	return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
}
