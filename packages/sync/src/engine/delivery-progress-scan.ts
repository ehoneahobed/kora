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

/** Fields that hold the delivery position: assigning one is a write of the position. */
export const POSITION_FIELDS = ['deliveryWatermark', 'accessRulesKey'] as const

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
	'ensureOfflineUnit',
] as const

/** Calls that, made synchronously, tell a caller the position its batch was received at moved. */
export const GUARDS = ['moved', 'positionMoved', 'deliveryContextChanged'] as const

/** One finding of the scan. */
export interface Site {
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

/** Scans `source` (the text of `sync-engine.ts`) and returns every finding. */
export function scanDeliveryPosition(source: string): Site[] {
	const file = ts.createSourceFile('sync-engine.ts', source, ts.ScriptTarget.Latest, true)
	const sites: Site[] = []
	const add = (rule: string, node: ts.Node): void => {
		const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
		sites.push({
			rule,
			member: memberOf(node),
			line: line + 1,
			text: node.getText(file).slice(0, 90),
		})
	}
	const visit = (node: ts.Node): void => {
		const name = accessedName(node)
		if (name !== null) {
			if ((POSITION_FIELDS as readonly string[]).includes(name) && isWriteTarget(node)) {
				add(`assign:${name}`, node)
			}
			if ((PERSISTENCE_METHODS as readonly string[]).includes(name)) {
				add(`persist:${name}`, node)
			}
			if (name === 'deliverySignatureWatermarks') {
				const parent = node.parent
				const method = ts.isPropertyAccessExpression(parent) ? parent.name.text : ''
				if (['set', 'delete', 'clear'].includes(method)) add(`cache:${method}`, node)
			}
			if ((BATCH_MUTATIONS as readonly string[]).includes(name) && !guardedBefore(node)) {
				add(`unguarded:${name}`, node)
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
			if (
				(isBinding || isShorthand) &&
				(PERSISTENCE_METHODS as readonly string[]).includes(node.text)
			) {
				add(`alias:${node.text}`, node)
			}
			if (
				(isBinding || isShorthand) &&
				(POSITION_FIELDS as readonly string[]).includes(node.text) &&
				isWriteTarget(node)
			) {
				add(`assign:${node.text}`, node)
			}
		}
		// `saveQuarantine(entries, progress)`: the second argument is a position, from anywhere.
		if (ts.isCallExpression(node)) {
			const callee = node.expression
			const target = accessedName(callee)
			if (target === 'saveQuarantine') {
				const carriesPosition =
					node.arguments.length !== 1 ||
					node.arguments.some((argument) => ts.isSpreadElement(argument))
				if (carriesPosition) add('persist:saveQuarantine-progress', node)
			}
			// A position written reflectively, or through a dynamically named member.
			if (ts.isPropertyAccessExpression(callee)) {
				const receiver = callee.expression.getText(file)
				if (
					(receiver === 'Object' &&
						['assign', 'defineProperty', 'defineProperties'].includes(callee.name.text)) ||
					receiver === 'Reflect'
				) {
					add(`reflective:${receiver}.${callee.name.text}`, node)
				}
			}
		}
		// `this[name]` reaches any member by a name the scan cannot read.
		if (
			ts.isElementAccessExpression(node) &&
			accessedName(node) === null &&
			node.expression.kind === ts.SyntaxKind.ThisKeyword
		) {
			add('dynamic-member-access', node)
		}
		// `const self = this` / `const { x } = this`: the position is then reachable under another name.
		if (
			ts.isVariableDeclaration(node) &&
			node.initializer !== undefined &&
			node.initializer.kind === ts.SyntaxKind.ThisKeyword
		) {
			add('alias-this', node)
		}
		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
			node.right.kind === ts.SyntaxKind.ThisKeyword
		) {
			add('alias-this', node)
		}
		ts.forEachChild(node, visit)
	}
	visit(file)
	return sites
}

/** Findings as `rule @ member` counted, the form the allowlist is written in. */
export function tally(sites: Site[]): Record<string, number> {
	const counts: Record<string, number> = {}
	for (const site of sites) {
		const key = `${site.rule} @ ${site.member}`
		counts[key] = (counts[key] ?? 0) + 1
	}
	return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
}
