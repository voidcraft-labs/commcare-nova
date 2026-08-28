import type { SyntaxNode } from "@lezer/common";
import {
	JAVAROSA_PATH_INITIALIZERS,
	pathInitializerStringArgument,
} from "@/lib/commcare/xpath/functionCapabilities";
import { parser } from "@/lib/commcare/xpath/parser";
import { toBoolean, toNumber } from "./coerce";
import { invokeFunction } from "./functions";
import {
	applyXPathBinaryOperation,
	isXPathBinaryOperation,
	missingXPathBinaryOperand,
} from "./operatorSemantics";
import {
	isXPathNodeSet,
	unpackXPathRuntimeValue,
	type XPathNode,
	XPathNodeSet,
	type XPathRuntimeValue,
} from "./runtimeValues";
import { selectCondArgument } from "./scalarJavaRosaFunctions";
import type { EvalContext, XPathValue } from "./types";

/** Path initializers the structural evaluator executes. */
export const PREVIEW_EXECUTABLE_PATH_INITIALIZERS: ReadonlySet<string> =
	new Set(["current", "instance"]);

// Pre-resolve all node types from the parser — zero string comparisons at runtime
// Child and Descendant appear twice in the grammar (rootStep vs expr), so use many().
const T = (() => {
	const all = parser.nodeSet.types;
	const one = (name: string) => {
		const found = all.find((t) => t.name === name);
		if (!found) throw new Error(`Unknown node type: ${name}`);
		return found;
	};
	const many = (name: string) => new Set(all.filter((t) => t.name === name));
	return {
		XPath: one("XPath"),
		NumberLiteral: one("NumberLiteral"),
		StringLiteral: one("StringLiteral"),
		HashtagRef: one("HashtagRef"),
		VariableReference: one("VariableReference"),
		// Two distinct Child/Descendant types (rootStep + expr)
		Children: many("Child"),
		Descendants: many("Descendant"),
		RootPath: one("RootPath"),
		SelfStep: one("SelfStep"),
		ParentStep: one("ParentStep"),
		NameTest: one("NameTest"),
		AttrSpecified: one("AttrSpecified"),
		AxisSpecified: one("AxisSpecified"),
		Invoke: one("Invoke"),
		FunctionName: one("FunctionName"),
		ArgumentList: one("ArgumentList"),
		Filtered: one("Filtered"),
		// Binary expressions
		AddExpr: one("AddExpr"),
		SubtractExpr: one("SubtractExpr"),
		MultiplyExpr: one("MultiplyExpr"),
		DivideExpr: one("DivideExpr"),
		ModulusExpr: one("ModulusExpr"),
		UnaryNegativeExpr: one("UnaryNegativeExpr"),
		EqualsExpr: one("EqualsExpr"),
		NotEqualsExpr: one("NotEqualsExpr"),
		LessThanExpr: one("LessThanExpr"),
		LessEqualExpr: one("LessEqualExpr"),
		GreaterThanExpr: one("GreaterThanExpr"),
		GreaterEqualExpr: one("GreaterEqualExpr"),
		AndExpr: one("AndExpr"),
		OrExpr: one("OrExpr"),
		UnionExpr: one("UnionExpr"),
		// Tokens
		OpenParen: one("("),
		CloseParen: one(")"),
		Slash: one("/"),
		Comma: one(","),
		Error: one("⚠"),
	};
})();

/**
 * Evaluate an XPath expression string and return a value.
 * Empty source is the XPath blank value. A parse error is unreachable after
 * the commit gate and therefore fails closed so the Preview containment
 * boundary can report the product invariant violation.
 */
export function evaluate(expr: string, context: EvalContext): XPathValue {
	return unpackXPathRuntimeValue(evaluateRuntime(expr, context));
}

/** Evaluate without prematurely collapsing nodesets or provisional sequences. */
export function evaluateRuntime(
	expr: string,
	context: EvalContext,
): XPathRuntimeValue {
	const trimmed = expr.trim();
	if (!trimmed) return "";

	const tree = parser.parse(trimmed);

	// Check for parse errors
	let hasError = false;
	tree.iterate({
		enter(n) {
			if (n.type === T.Error) hasError = true;
		},
	});
	if (hasError) {
		throw new Error("Preview received XPath that did not pass admission.");
	}

	return evalNode(tree.topNode, trimmed, context);
}

/** Recursively evaluate a Lezer CST node. */
function evalNode(
	node: SyntaxNode,
	source: string,
	ctx: EvalContext,
): XPathRuntimeValue {
	const type = node.type;

	// ── XPath root — evaluate its single child expression ──
	if (type === T.XPath) {
		// The grammar splices grouping parens flat into the parent — `(expr)`
		// parses as `XPath → "(" expr ")"` with no wrapper node — so the
		// root's first child can be the `(` TOKEN. Skip paren tokens to reach
		// the inner expression; evaluating the token would fall through every
		// dispatch branch and return blank for any fully-parenthesized root.
		let child = node.firstChild;
		while (child && child.type === T.OpenParen) {
			child = child.nextSibling;
		}
		if (!child || child.type === T.CloseParen) return "";
		return evalNode(child, source, ctx);
	}

	// ── Literals ──
	if (type === T.NumberLiteral) {
		return parseFloat(source.slice(node.from, node.to));
	}
	if (type === T.StringLiteral) {
		const raw = source.slice(node.from, node.to);
		// Strip surrounding quotes (single or double)
		return raw.slice(1, -1);
	}

	// ── Hashtag references (#<case-type>/prop, #form/id, #user/prop) ──
	if (type === T.HashtagRef) {
		const text = source.slice(node.from, node.to);
		// The main-instance projection owns #form even when the context also
		// installs the structural resolver used by case and user hashtags. Taking
		// that hook first collapses repeat children to its scalar fallback before
		// nodeset-aware functions can observe their cardinality.
		if (text.startsWith("#form/") && ctx.mainInstance) {
			return selectFormSegments(
				ctx.mainInstance.root(),
				["data", ...text.slice("#form/".length).split("/")],
				ctx.contextNode,
			);
		}
		if (ctx.resolveHashtagValue) return ctx.resolveHashtagValue(text);
		return ctx.resolveHashtag(text);
	}

	// ── Variable references ($var) ──
	if (type === T.VariableReference) {
		throw new Error("Preview received an unbound XPath variable.");
	}

	// ── Self step (.) ──
	if (type === T.SelfStep) {
		if (ctx.contextNode) return new XPathNodeSet([ctx.contextNode]);
		return ctx.getValue(ctx.contextPath) ?? "";
	}

	// ── Parent step (..) ──
	if (type === T.ParentStep) {
		if (ctx.contextNode) {
			const parent = ctx.contextNode.parent();
			return new XPathNodeSet(parent ? [parent] : []);
		}
		const parentPath = ctx.contextPath.replace(/\/[^/]+$/, "");
		return ctx.getValue(parentPath) ?? "";
	}

	// ── NameTest (bare name like 'data' or 'question_id') ──
	if (type === T.NameTest) {
		const name = source.slice(node.from, node.to);
		if (ctx.contextNode) {
			return selectChildren(new XPathNodeSet([ctx.contextNode]), name);
		}
		// Try as a path relative to context
		const path = `${ctx.contextPath}/${name}`;
		return ctx.getValue(path) ?? "";
	}

	// ── Root path (bare /) ──
	if (type === T.RootPath) {
		if (ctx.mainInstance) return new XPathNodeSet([ctx.mainInstance.root()]);
		return "";
	}

	if (type === T.AttrSpecified || type === T.AxisSpecified) {
		if (ctx.contextNode) {
			return applyStructuralStep(
				new XPathNodeSet([ctx.contextNode]),
				node,
				source,
			);
		}
		return "";
	}

	// ── Path expressions (Child: expr/step, Descendant: expr//step) ──
	if (T.Children.has(type) || T.Descendants.has(type)) {
		if (T.Descendants.has(type) && hasStructuralContext(ctx)) {
			throw new Error("Unsupported XPath descendant axis in JavaRosa: //");
		}
		if (hasStructuralContext(ctx)) {
			return evalStructuralPath(node, source, ctx);
		}
		const reference = buildPath(node, source);
		if (reference?.instanceId !== undefined) {
			const resolution = ctx.resolveInstance?.(
				reference.instanceId,
				reference.path,
			);
			if (resolution?.kind !== "supported") {
				throw new Error(
					`Unsupported XPath instance in Preview: instance('${reference.instanceId}')`,
				);
			}
			return resolution.value ?? "";
		}
		if (reference) return ctx.getValue(reference.path) ?? "";
		return "";
	}

	// ── Unary negative ──
	if (type === T.UnaryNegativeExpr) {
		// The operand is the first expression child, not the last child: a
		// parenthesized operand (`-(2)`) splices its `)` token flat as the
		// last child.
		const [operand] = getBinaryOperands(node);
		return operand ? -toNumber(evalNode(operand, source, ctx)) : 0;
	}

	// ── Binary arithmetic and comparison ──
	if (isXPathBinaryOperation(type.name)) {
		const [left, right] = getBinaryOperands(node);
		if (!left || !right) return missingXPathBinaryOperand(type.name);
		return applyXPathBinaryOperation(
			type.name,
			evalNode(left, source, ctx),
			evalNode(right, source, ctx),
		);
	}

	// ── Logical (short-circuit) ──
	if (type === T.AndExpr) {
		const [left, right] = getBinaryOperands(node);
		if (!left || !right) return false;
		return (
			toBoolean(evalNode(left, source, ctx)) &&
			toBoolean(evalNode(right, source, ctx))
		);
	}
	if (type === T.OrExpr) {
		const [left, right] = getBinaryOperands(node);
		if (!left || !right) return false;
		return (
			toBoolean(evalNode(left, source, ctx)) ||
			toBoolean(evalNode(right, source, ctx))
		);
	}

	// ── Union ──
	if (type === T.UnionExpr) {
		throw new Error("Unsupported XPath nodeset union operation in JavaRosa.");
	}

	// ── Function invocation ──
	if (type === T.Invoke) {
		return evalInvoke(node, source, ctx);
	}

	// ── Filtered (predicate) — expr[pred] ──
	if (type === T.Filtered) {
		if (hasStructuralContext(ctx)) {
			return evalStructuralFilter(node, source, ctx);
		}
		throw new Error(
			"Preview cannot evaluate a filtered XPath without structural context.",
		);
	}

	// ── Parenthesized expression ──
	// The grammar splices grouping parens flat into the PARENT node, so a
	// binary node's first child can be the `(` token: `(a) and b` parses as
	// `AndExpr → "(" a ")" and b`. Every typed branch above already skips
	// paren tokens when it collects operands, which is why this branch sits
	// BELOW them — placed first, it returned the inner expression alone and
	// silently dropped the rest of the binary expression (`(a) and b` → a,
	// `(1 + 2) * 3` → 3).
	const first = node.firstChild;
	if (first && first.type === T.OpenParen) {
		const inner = first.nextSibling;
		if (inner && inner.type !== T.CloseParen) {
			return evalNode(inner, source, ctx);
		}
		return "";
	}

	throw new Error("Preview reached unsupported admitted XPath syntax.");
}

/** Internal syntax-node entrypoint used by the async companion. The async
 * evaluator delegates every subtree without an async call here, so ordinary
 * XPath semantics continue to have one implementation. */
export function evaluateSyntaxNode(
	node: SyntaxNode,
	source: string,
	context: EvalContext,
): XPathRuntimeValue {
	return evalNode(node, source, context);
}

/** Evaluate a function invocation node. */
function evalInvoke(
	node: SyntaxNode,
	source: string,
	ctx: EvalContext,
): XPathRuntimeValue {
	let fnName = "";
	let argNodes: SyntaxNode[] = [];

	let child = node.firstChild;
	while (child) {
		if (child.type === T.FunctionName) {
			fnName = source.slice(child.from, child.to);
		} else if (child.type === T.ArgumentList) {
			argNodes = argumentNodes(child);
		}
		child = child.nextSibling;
	}

	if (fnName === "current") {
		if (argNodes.length !== 0) {
			throw new Error("current() requires zero arguments.");
		}
		const original = ctx.originalContextNode ?? ctx.contextNode;
		if (!original) {
			throw new Error("current() has no original XPath context node.");
		}
		return new XPathNodeSet([original]);
	}

	if (fnName === "instance" && ctx.resolveXPathInstance) {
		const instanceId = pathInitializerStringArgument(node, source);
		if (instanceId === undefined) {
			throw new Error("instance() requires one string-literal instance id.");
		}
		const instance = ctx.resolveXPathInstance(instanceId);
		if (!instance) {
			throw new Error(
				`Unsupported XPath instance in Preview: instance('${instanceId}')`,
			);
		}
		return new XPathNodeSet([instance.root()]);
	}

	// JavaRosa evaluates only the selected branch of these functions. Preserve
	// that laziness so an unsupported call in an unreachable branch cannot make
	// Preview reject an expression the device evaluates successfully.
	if (fnName === "if") {
		const condition = argNodes[0];
		const selected = toBoolean(
			condition ? evalNode(condition, source, ctx) : "",
		)
			? argNodes[1]
			: argNodes[2];
		return selected ? evalNode(selected, source, ctx) : "";
	}
	if (fnName === "cond") {
		const selectedIndex = selectCondArgument(argNodes.length, (index) => {
			const predicate = argNodes[index];
			return predicate ? evalNode(predicate, source, ctx) : false;
		});
		const selected = argNodes[selectedIndex];
		return selected ? evalNode(selected, source, ctx) : "";
	}
	if (fnName === "coalesce") {
		// Pinned Core's coalesce() is unusual: XPathFuncExpr first evaluates every
		// argument eagerly, then XpathCoalesceFunc evaluates candidate arms again
		// while selecting the first nonblank scalar. Preserve both passes because
		// failures and volatile functions make that order observable.
		for (const arg of argNodes) evalNode(arg, source, ctx);
		for (const arg of argNodes.slice(0, -1)) {
			const scalar = unpackXPathRuntimeValue(evalNode(arg, source, ctx));
			if (
				scalar !== "" &&
				!(typeof scalar === "number" && Number.isNaN(scalar))
			) {
				return scalar;
			}
		}
		const fallback = argNodes.at(-1);
		return fallback ? evalNode(fallback, source, ctx) : "";
	}

	// Preview can preserve the context form of position(), but its scalar path
	// model cannot represent JavaRosa's optional nodeset argument.
	if (fnName === "position") {
		if (argNodes.length > 1) {
			throw new Error("position() accepts zero or one argument.");
		}
		if (argNodes.length === 1) {
			if (!ctx.mainInstance && !ctx.contextNode) {
				throw new Error(
					"Unsupported XPath function signature in Preview: position(nodeset)",
				);
			}
			const selected = evalNode(argNodes[0], source, ctx);
			if (!isXPathNodeSet(selected)) {
				throw new Error("position(reference) requires a nodeset.");
			}
			const first = selected.nodes[0];
			if (!first)
				throw new Error("Unable to evaluate position() on an empty reference.");
			return first.multiplicity;
		}
		return ctx.position ?? ctx.contextNode?.multiplicity ?? 0;
	}

	const args = argNodes.map((arg) => evalNode(arg, source, ctx));

	/* Built-ins such as count() consume nodesets structurally. Try them before
	 * projecting arguments onto the scalar-only generated-function boundary;
	 * otherwise an unrelated generated dispatcher would eagerly unpack a
	 * multi-node argument before count() can observe it. */
	const invocation = invokeFunction(fnName, args, { locale: ctx.locale });
	if (invocation.kind === "handled") return invocation.value;
	const generatedInvocation = ctx.invokeGeneratedFunction?.(
		fnName,
		args.map(unpackXPathRuntimeValue),
	);
	if (generatedInvocation?.kind === "handled") {
		return generatedInvocation.value;
	}

	throw new Error(`Unsupported XPath function in Preview: ${fnName}()`);
}
function argumentNodes(argumentList: SyntaxNode): SyntaxNode[] {
	const args: SyntaxNode[] = [];
	let arg = argumentList.firstChild;
	while (arg) {
		if (
			arg.type !== T.OpenParen &&
			arg.type !== T.CloseParen &&
			arg.type !== T.Comma
		) {
			args.push(arg);
		}
		arg = arg.nextSibling;
	}
	return args;
}

function evalStructuralPath(
	node: SyntaxNode,
	source: string,
	ctx: EvalContext,
): XPathNodeSet {
	if (T.Descendants.has(node.type)) {
		throw new Error("Unsupported XPath descendant axis in JavaRosa: //");
	}
	const expressions = directExpressionChildren(node);
	const beginsAtRoot = node.firstChild?.type === T.Slash;
	let base: XPathRuntimeValue;
	let step: SyntaxNode | undefined;
	if (beginsAtRoot) {
		if (!ctx.mainInstance) {
			throw new Error("Absolute XPath path has no main instance.");
		}
		base = new XPathNodeSet([ctx.mainInstance.root()]);
		step = expressions[0];
	} else {
		const baseNode = expressions[0];
		step = expressions[1];
		base = baseNode ? evalNode(baseNode, source, ctx) : new XPathNodeSet([]);
	}
	if (!isXPathNodeSet(base)) {
		throw new Error("XPath path root did not evaluate to a nodeset.");
	}
	const selected = step ? applyStructuralStep(base, step, source) : base;
	return contextualizeAbsolutePathSelection(node, source, ctx, selected);
}

/**
 * JavaRosa contextualizes an unbound same-instance absolute reference against
 * the evaluating node. As the recursive path walk reaches a repeat shared by
 * the expression and its context, bind that step to the context's concrete
 * multiplicity. A predicate or explicit position on THIS step already binds
 * that level, so Core does not overwrite it and neither do we; an earlier
 * predicate must not suppress contextualization of a deeper unbound repeat.
 *
 * Exported for the async companion, which owns the same path walk whenever a
 * descendant invocation yields in the browser worker.
 */
export function contextualizeAbsolutePathSelection(
	node: SyntaxNode,
	source: string,
	context: EvalContext,
	selection: XPathNodeSet,
): XPathNodeSet {
	const expression = source.slice(node.from, node.to).trimStart();
	if (!expression.startsWith("/") || node.parent?.type === T.Filtered) {
		return selection;
	}
	const contextNode = context.contextNode;
	if (contextNode === undefined || selection.candidates.length < 2) {
		return selection;
	}

	const contextSegments = indexedPathSegments(contextNode.path);
	const first = selection.candidates[0];
	if (first === undefined) return selection;
	const selectedSegments = indexedPathSegments(first.path);
	if (
		selectedSegments.length === 0 ||
		selectedSegments.length > contextSegments.length ||
		!selectedSegments.every(
			(segment, index) => segment.name === contextSegments[index]?.name,
		)
	) {
		return selection;
	}

	const concreteContextPath = `/${contextSegments
		.slice(0, selectedSegments.length)
		.map(({ name, multiplicity }) =>
			multiplicity === undefined ? name : `${name}[${multiplicity}]`,
		)
		.join("/")}`;
	const bound = selection.candidates.filter(
		(candidate) => candidate.path === concreteContextPath,
	);
	return bound.length === 0
		? selection
		: new XPathNodeSet(bound, selection.validPath, bound);
}

export function applyStructuralStep(
	base: XPathNodeSet,
	step: SyntaxNode,
	source: string,
): XPathNodeSet {
	if (step.type === T.NameTest) {
		return selectChildren(base, source.slice(step.from, step.to));
	}
	if (step.type === T.SelfStep) return base;
	if (step.type === T.ParentStep) {
		return selectParents(base);
	}
	if (step.type === T.AttrSpecified) {
		const name = step.getChild(T.NameTest.id);
		return selectAttributes(
			base,
			name ? source.slice(name.from, name.to) : "*",
		);
	}
	if (step.type === T.AxisSpecified) {
		const separator = source.slice(step.from, step.to).indexOf("::");
		const axis = source.slice(step.from, step.from + separator).trim();
		const nameNode = step.getChild(T.NameTest.id);
		const name = nameNode ? source.slice(nameNode.from, nameNode.to) : "*";
		switch (axis) {
			case "child":
				return selectChildren(base, name);
			case "attribute":
				return selectAttributes(base, name);
			case "self":
				return selectNamedNodes(base, name);
			case "parent":
				return selectNamedNodes(selectParents(base), name);
			default:
				throw new Error(`Unsupported XPath axis in JavaRosa: ${axis}::`);
		}
	}
	throw new Error(
		`Unsupported XPath path step: ${source.slice(step.from, step.to)}`,
	);
}

function selectNamedNodes(base: XPathNodeSet, name: string): XPathNodeSet {
	if (name === "*") return base;
	return new XPathNodeSet(
		base.candidates.filter((node) => node.name === name),
		base.validPath,
		base.schemaNodes.filter((node) => node.name === name),
	);
}

function selectParents(base: XPathNodeSet): XPathNodeSet {
	const uniqueParents = (nodes: readonly XPathNode[]) => {
		const parents: XPathNode[] = [];
		const seen = new Set<string>();
		for (const node of nodes) {
			const parent = node.parent();
			if (!parent) continue;
			const key = `${parent.instanceId ?? "main"}:${parent.path}`;
			if (!seen.has(key)) {
				seen.add(key);
				parents.push(parent);
			}
		}
		return parents;
	};
	return new XPathNodeSet(
		uniqueParents(base.candidates),
		base.validPath,
		uniqueParents(base.schemaNodes),
	);
}

function selectChildren(base: XPathNodeSet, name: string): XPathNodeSet {
	const nodes = base.candidates.flatMap((node) => [...node.children(name)]);
	const schemaNodes = base.schemaNodes.flatMap((node) => [
		...(node.templateChildren?.(name) ?? node.children(name)),
	]);
	const templateExists = base.schemaNodes.some((node) =>
		node.hasChildTemplate(name),
	);
	return new XPathNodeSet(nodes, base.validPath && templateExists, schemaNodes);
}

function selectAttributes(base: XPathNodeSet, name: string): XPathNodeSet {
	const nodes = base.candidates.flatMap((node) => [...node.attributes(name)]);
	const schemaNodes = base.schemaNodes.flatMap((node) => [
		...(node.templateAttributes?.(name) ?? node.attributes(name)),
	]);
	const templateExists = base.schemaNodes.some((node) =>
		node.hasAttributeTemplate(name),
	);
	return new XPathNodeSet(nodes, base.validPath && templateExists, schemaNodes);
}

/**
 * Resolve a canonical #form path while preserving every repeat multiplicity
 * already fixed by the evaluating node. JavaRosa's references are index-free
 * in the model, but a calculation inside `/data/items[1]` reads the sibling
 * fields from `items[1]`, not every `items` occurrence in the instance.
 */
function selectFormSegments(
	root: XPathNode,
	segments: readonly string[],
	contextNode: XPathNode | undefined,
): XPathNodeSet {
	const contextualSegments = contextNode
		? indexedPathSegments(contextNode.path)
		: [];
	let selected = new XPathNodeSet([root]);
	for (let index = 0; index < segments.length; index += 1) {
		const segment = segments[index] ?? "";
		selected = selectChildren(selected, segment);
		const contextual = contextualSegments[index];
		if (
			contextual?.name === segment &&
			contextual.multiplicity !== undefined &&
			segments
				.slice(0, index + 1)
				.every(
					(name, segmentIndex) =>
						contextualSegments[segmentIndex]?.name === name,
				)
		) {
			selected = new XPathNodeSet(
				selected.candidates.filter(
					(node) => node.multiplicity === contextual.multiplicity,
				),
				selected.validPath,
				selected.schemaNodes,
			);
		}
	}
	return selected;
}

function indexedPathSegments(
	path: string,
): readonly { name: string; multiplicity?: number }[] {
	return path
		.split("/")
		.filter(Boolean)
		.map((segment) => {
			const match = /^([^[]+)(?:\[(\d+)\])?$/.exec(segment);
			if (!match) return { name: segment };
			const name = match[1] ?? segment;
			return match[2] === undefined
				? { name }
				: { name, multiplicity: Number.parseInt(match[2], 10) };
		});
}

function hasStructuralContext(ctx: EvalContext): boolean {
	return (
		ctx.mainInstance !== undefined ||
		ctx.contextNode !== undefined ||
		ctx.resolveXPathInstance !== undefined
	);
}

function evalStructuralFilter(
	node: SyntaxNode,
	source: string,
	ctx: EvalContext,
): XPathNodeSet {
	const expressions = directExpressionChildren(node);
	const baseNode = expressions[0];
	const predicate = expressions[1];
	if (!baseNode || !predicate) return new XPathNodeSet([]);
	const base = evalNode(baseNode, source, ctx);
	if (!isXPathNodeSet(base)) {
		throw new Error(
			"Unsupported standalone XPath filter expression in JavaRosa.",
		);
	}
	const selected: XPathNode[] = [];
	for (let index = 0; index < base.candidates.length; index += 1) {
		const candidate = base.candidates[index];
		if (!candidate) continue;
		const value = evalNode(
			predicate,
			source,
			xpathPredicateContext(ctx, candidate, index),
		);
		if (xpathPredicateMatches(value, index)) selected.push(candidate);
	}
	return new XPathNodeSet(selected, base.validPath, base.schemaNodes);
}

export function directExpressionChildren(node: SyntaxNode): SyntaxNode[] {
	const expressions: SyntaxNode[] = [];
	let child = node.firstChild;
	while (child) {
		if (
			child.type === T.NumberLiteral ||
			child.type === T.StringLiteral ||
			child.type === T.HashtagRef ||
			child.type === T.VariableReference ||
			child.type === T.NameTest ||
			child.type === T.SelfStep ||
			child.type === T.ParentStep ||
			child.type === T.RootPath ||
			child.type === T.Invoke ||
			child.type === T.Filtered ||
			child.type === T.AttrSpecified ||
			child.type === T.AxisSpecified ||
			T.Children.has(child.type) ||
			T.Descendants.has(child.type) ||
			child.firstChild !== null
		) {
			expressions.push(child);
		}
		child = child.nextSibling;
	}
	return expressions;
}

export function xpathPredicateContext(
	context: EvalContext,
	candidate: XPathNode,
	zeroBasedIndex: number,
): EvalContext {
	return {
		...context,
		contextNode: candidate,
		contextPath: candidate.path,
		position: zeroBasedIndex + 1,
		originalContextNode:
			context.originalContextNode ?? context.contextNode ?? candidate,
	};
}

export function xpathPredicateMatches(
	value: XPathRuntimeValue,
	zeroBasedIndex: number,
): boolean {
	const scalar = unpackXPathRuntimeValue(value);
	return typeof scalar === "boolean"
		? scalar
		: typeof scalar === "number"
			? javaIntValue(scalar) === zeroBasedIndex + 1
			: false;
}

/** Java's Double.intValue() narrowing used by numeric predicates. */
function javaIntValue(value: number): number {
	if (Number.isNaN(value)) return 0;
	if (value >= 2_147_483_647) return 2_147_483_647;
	if (value <= -2_147_483_648) return -2_147_483_648;
	return Math.trunc(value);
}

/**
 * Build an absolute path string from a path expression CST node.
 * Walks left-recursive Child/Descendant nodes to collect segments.
 */
interface PreviewPathReference {
	readonly path: string;
	readonly instanceId?: string;
}

function buildPath(
	node: SyntaxNode,
	source: string,
): PreviewPathReference | null {
	const segments: string[] = [];
	const root: { instanceId?: string } = {};
	collectSegments(node, source, segments, root);
	if (segments.length === 0) return null;
	return {
		path: `/${segments.join("/")}`,
		...(root.instanceId === undefined ? {} : { instanceId: root.instanceId }),
	};
}

function collectSegments(
	node: SyntaxNode,
	source: string,
	segments: string[],
	root: { instanceId?: string },
): void {
	let child = node.firstChild;
	while (child) {
		if (T.Children.has(child.type) || T.Descendants.has(child.type)) {
			collectSegments(child, source, segments, root);
		} else if (child.type === T.Invoke) {
			const nameNode = child.getChild(T.FunctionName.id);
			const name = nameNode
				? source.slice(nameNode.from, nameNode.to)
				: "unknown";
			if (!JAVAROSA_PATH_INITIALIZERS.has(name)) {
				throw new Error(
					`Unsupported XPath path initializer in Preview: ${name}()`,
				);
			}
			if (name !== "instance") {
				throw new Error(
					`Unsupported XPath path initializer in Preview: ${name}()`,
				);
			}
			const instanceId = pathInitializerStringArgument(child, source);
			if (instanceId === undefined) {
				throw new Error(
					`Unsupported XPath instance in Preview: instance('${instanceId ?? "?"}')`,
				);
			}
			root.instanceId = instanceId;
		} else if (child.type === T.NameTest) {
			segments.push(source.slice(child.from, child.to));
		} else if (child.type === T.RootPath || child.type === T.Slash) {
			// Skip slash tokens
		}
		child = child.nextSibling;
	}
}

/** Get left and right operands of a binary expression (skipping operator tokens). */
export function getBinaryOperands(
	node: SyntaxNode,
): [SyntaxNode | null, SyntaxNode | null] {
	const children: SyntaxNode[] = [];
	let child = node.firstChild;
	while (child) {
		// Skip operator tokens (they have no children and are single-char/keyword tokens)
		if (child.firstChild || isExpressionNode(child)) {
			children.push(child);
		}
		child = child.nextSibling;
	}
	return [children[0] ?? null, children[1] ?? null];
}

/** Check if a leaf node is an expression value (literal, ref, nametest, self, etc.) */
function isExpressionNode(node: SyntaxNode): boolean {
	return (
		node.type === T.NumberLiteral ||
		node.type === T.StringLiteral ||
		node.type === T.HashtagRef ||
		node.type === T.VariableReference ||
		node.type === T.NameTest ||
		node.type === T.SelfStep ||
		node.type === T.ParentStep ||
		node.type === T.RootPath ||
		T.Children.has(node.type) ||
		T.Descendants.has(node.type)
	);
}
