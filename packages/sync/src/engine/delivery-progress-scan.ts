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
] as const

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
] as const

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

function callsGuard(node: ts.Node): boolean {
	let found = false
	const visit = (child: ts.Node): void => {
		if (found) return
		// Defining a check (`const moved = () => ...`) is not making one.
		if (ts.isFunctionLike(child) && child !== node) return
		if (ts.isCallExpression(child)) {
			const callee = child.expression
			const name = ts.isIdentifier(callee) ? callee.text : accessedName(callee)
			if (name !== null && (GUARDS as readonly string[]).includes(name)) found = true
		}
		ts.forEachChild(child, visit)
	}
	visit(node)
	return found
}

/** Whether `node` awaits something that does not contain `except`. */
function awaitsApartFrom(node: ts.Node, except: ts.Node): boolean {
	let found = false
	const visit = (child: ts.Node): void => {
		if (found || child === except) return
		if (ts.isAwaitExpression(child) && !containsNode(child, except)) found = true
		if (ts.isFunctionLike(child) && child !== node) return
		ts.forEachChild(child, visit)
	}
	visit(node)
	return found
}

function containsNode(outer: ts.Node, inner: ts.Node): boolean {
	return outer.pos <= inner.pos && inner.end <= outer.end
}

const LOOPS = [
	ts.SyntaxKind.ForStatement,
	ts.SyntaxKind.ForOfStatement,
	ts.SyntaxKind.ForInStatement,
	ts.SyntaxKind.WhileStatement,
	ts.SyntaxKind.DoStatement,
]

/**
 * Whether a synchronous position check precedes `call` in its own function with no await between
 * the check and the call. A loop body must carry its own check (the previous iteration awaited).
 */
function guardedBefore(call: ts.Node): boolean {
	let node: ts.Node = call
	let awaitedSince = false
	while (node.parent !== undefined) {
		const parent: ts.Node = node.parent
		if (ts.isFunctionLike(parent)) return false
		if (ts.isBlock(parent) || ts.isSourceFile(parent) || ts.isCaseClause(parent)) {
			const statements: readonly ts.Statement[] = ts.isCaseClause(parent)
				? parent.statements
				: parent.statements
			const at = statements.indexOf(node as ts.Statement)
			for (let index = at - 1; index >= 0; index--) {
				const earlier = statements[index] as ts.Statement
				if (callsGuard(earlier)) return !awaitedSince
				if (awaitsApartFrom(earlier, call)) awaitedSince = true
			}
		}
		if (LOOPS.includes(parent.kind)) {
			// A guard before the loop does not cover a later iteration, unless the loop never awaits.
			const loopBody =
				ts.isForStatement(parent) ||
				ts.isForOfStatement(parent) ||
				ts.isForInStatement(parent) ||
				ts.isWhileStatement(parent) ||
				ts.isDoStatement(parent)
					? parent.statement
					: parent
			if (awaitsApartFrom(loopBody, call)) return false
		}
		node = parent
	}
	return false
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
			if (names(BATCH_MUTATIONS, name) && !guardedBefore(node)) add(`unguarded:${name}`, node)
		}
		if (ts.isIdentifier(node)) {
			// A name reached without a property access: a shorthand `{ saveDeliveryWatermark }`
			// or a destructured alias `const { saveDeliveryWatermark: save } = this.syncState`.
			const parent = node.parent
			const isBinding =
				ts.isBindingElement(parent) &&
				(parent.propertyName === undefined ? parent.name === node : parent.propertyName === node)
			const isShorthand = ts.isShorthandPropertyAssignment(parent) && parent.name === node
			if (isBinding || isShorthand) {
				if (names(PERSISTENCE_METHODS, node.text)) add(`alias:${node.text}`, node)
				if (names(POSITION_MUTATORS, node.text) || node.text === 'writer') {
					add(`alias:${node.text}`, node)
				}
				if (names(BATCH_MUTATIONS, node.text)) add(`alias:${node.text}`, node)
				if (names(POSITION_FIELDS, node.text) && isWriteTarget(node)) {
					add(`assign:${node.text}`, node)
				}
			}
			// Reflection and aliases of the global objects that write through them.
			if (node.text === 'Reflect' || node.text === 'globalThis')
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
