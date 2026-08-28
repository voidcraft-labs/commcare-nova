import type { SyntaxNode } from "@lezer/common";
import { parser } from "@/lib/commcare/xpath/parser";
import { toBoolean, toNumber, xpathToString } from "./coerce";
import {
	applyStructuralStep,
	contextualizeAbsolutePathSelection,
	directExpressionChildren,
	evaluateSyntaxNode,
	getBinaryOperands,
	xpathPredicateContext,
	xpathPredicateMatches,
} from "./evaluator";
import { invokeFunction } from "./functions";
import { prepareOpenJdk17Pattern } from "./javaPatternNamedCharacters";
import { javaRosaRegex, javaRosaReplace } from "./javaPatternRuntime";
import { javaRosaDecryptString, javaRosaEncryptString } from "./javaRosaCrypto";
import { javaRosaSleep } from "./javaRosaSleep";
import {
	applyXPathBinaryOperation,
	isXPathBinaryOperation,
	missingXPathBinaryOperand,
} from "./operatorSemantics";
import {
	isXPathNodeSet,
	unpackXPathRuntimeValue,
	XPathNodeSet,
	type XPathRuntimeValue,
} from "./runtimeValues";
import type { EvalContext, XPathValue } from "./types";

export const ASYNC_XPATH_FUNCTIONS: ReadonlySet<string> = new Set([
	"decrypt-string",
	"encrypt-string",
	"regex",
	"replace",
	"sleep",
]);

export interface XPathAsyncEvaluationTools {
	readonly signal?: AbortSignal;
	readonly delay?: (milliseconds: number) => Promise<void>;
	readonly crypto?: Pick<Crypto, "getRandomValues" | "subtle">;
	readonly encryptString?: (
		message: string,
		keyBase64: string,
		algorithm: string,
	) => Promise<string>;
	readonly decryptString?: (
		payloadBase64: string,
		keyBase64: string,
		algorithm: string,
	) => Promise<string>;
}

/** Async companion to evaluateRuntime. A subtree that contains no yielding
 * function is evaluated exactly once by the synchronous evaluator. */
export async function evaluateRuntimeAsync(
	expression: string,
	context: EvalContext,
	tools: XPathAsyncEvaluationTools = {},
): Promise<XPathRuntimeValue> {
	const source = expression.trim();
	if (source === "") return "";
	const tree = parser.parse(source);
	let hasParseError = false;
	tree.iterate({
		enter(node) {
			if (node.type.isError) hasParseError = true;
		},
	});
	if (hasParseError) {
		throw new Error("Preview received XPath that did not pass admission.");
	}
	return evaluateAsyncNode(tree.topNode, source, context, tools);
}

export async function evaluateAsync(
	expression: string,
	context: EvalContext,
	tools: XPathAsyncEvaluationTools = {},
): Promise<XPathValue> {
	return unpackXPathRuntimeValue(
		await evaluateRuntimeAsync(expression, context, tools),
	);
}

async function evaluateAsyncNode(
	node: SyntaxNode,
	source: string,
	context: EvalContext,
	tools: XPathAsyncEvaluationTools,
): Promise<XPathRuntimeValue> {
	throwIfAborted(tools.signal);
	if (!containsAsyncFunction(node, source)) {
		return evaluateSyntaxNode(node, source, context);
	}

	const type = node.type.name;
	if (type === "XPath") {
		const child = firstExpressionChild(node);
		return child === undefined
			? ""
			: evaluateAsyncNode(child, source, context, tools);
	}
	if (type === "Invoke") {
		return evaluateAsyncInvoke(node, source, context, tools);
	}
	if (type === "Filtered") {
		return evaluateAsyncFilter(node, source, context, tools);
	}
	if (type === "Child" || type === "Descendant") {
		if (type === "Descendant") {
			throw new Error("Unsupported XPath descendant axis in JavaRosa: //");
		}
		const expressions = directExpressionChildren(node);
		const beginsAtRoot = node.firstChild?.type.name === "/";
		let base: XPathRuntimeValue;
		let step: SyntaxNode | undefined;
		if (beginsAtRoot) {
			if (!context.mainInstance) {
				throw new Error("Absolute XPath path has no main instance.");
			}
			base = new XPathNodeSet([context.mainInstance.root()]);
			step = expressions[0];
		} else {
			const baseNode = expressions[0];
			step = expressions[1];
			base = baseNode
				? await evaluateAsyncNode(baseNode, source, context, tools)
				: new XPathNodeSet([]);
		}
		if (!isXPathNodeSet(base)) {
			throw new Error("XPath path root did not evaluate to a nodeset.");
		}
		const selected = step ? applyStructuralStep(base, step, source) : base;
		return contextualizeAbsolutePathSelection(node, source, context, selected);
	}
	if (type === "UnaryNegativeExpr") {
		const [operand] = getBinaryOperands(node);
		return operand
			? -toNumber(await evaluateAsyncNode(operand, source, context, tools))
			: 0;
	}
	if (type === "AndExpr" || type === "OrExpr") {
		const [left, right] = getBinaryOperands(node);
		if (!left || !right) return false;
		const leftValue = toBoolean(
			await evaluateAsyncNode(left, source, context, tools),
		);
		if (type === "AndExpr" && !leftValue) return false;
		if (type === "OrExpr" && leftValue) return true;
		return toBoolean(await evaluateAsyncNode(right, source, context, tools));
	}
	if (type === "UnionExpr") {
		throw new Error("Unsupported XPath nodeset union operation in JavaRosa.");
	}
	if (isXPathBinaryOperation(type)) {
		const [left, right] = getBinaryOperands(node);
		if (!left || !right) return missingXPathBinaryOperand(type);
		const leftValue = await evaluateAsyncNode(left, source, context, tools);
		const rightValue = await evaluateAsyncNode(right, source, context, tools);
		return applyXPathBinaryOperation(type, leftValue, rightValue);
	}

	const first = firstExpressionChild(node);
	return first === undefined
		? ""
		: evaluateAsyncNode(first, source, context, tools);
}

async function evaluateAsyncInvoke(
	node: SyntaxNode,
	source: string,
	context: EvalContext,
	tools: XPathAsyncEvaluationTools,
): Promise<XPathRuntimeValue> {
	const nameNode = node.getChild("FunctionName");
	const name = nameNode ? source.slice(nameNode.from, nameNode.to) : "";
	const argumentList = node.getChild("ArgumentList");
	const args = argumentList ? argumentNodes(argumentList) : [];

	if (name === "if") {
		const condition = args[0];
		const selected = toBoolean(
			condition
				? await evaluateAsyncNode(condition, source, context, tools)
				: "",
		)
			? args[1]
			: args[2];
		return selected ? evaluateAsyncNode(selected, source, context, tools) : "";
	}
	if (name === "cond") {
		for (let index = 0; index < args.length - 2; index += 2) {
			const predicate = args[index];
			if (
				predicate &&
				toBoolean(await evaluateAsyncNode(predicate, source, context, tools))
			) {
				const selected = args[index + 1];
				return selected
					? evaluateAsyncNode(selected, source, context, tools)
					: "";
			}
		}
		const fallback = args.at(-1);
		return fallback ? evaluateAsyncNode(fallback, source, context, tools) : "";
	}
	if (name === "coalesce") {
		// Core evaluates all arguments once in XPathFuncExpr, then evaluates
		// candidate arms again inside XpathCoalesceFunc while selecting a result.
		// The eager pass is observable when a later arm fails or an arm is volatile.
		for (const arg of args) {
			await evaluateAsyncNode(arg, source, context, tools);
		}
		for (const arg of args.slice(0, -1)) {
			const scalar = unpackXPathRuntimeValue(
				await evaluateAsyncNode(arg, source, context, tools),
			);
			if (
				scalar !== "" &&
				!(typeof scalar === "number" && Number.isNaN(scalar))
			) {
				return scalar;
			}
		}
		const fallback = args.at(-1);
		return fallback ? evaluateAsyncNode(fallback, source, context, tools) : "";
	}

	const values: XPathRuntimeValue[] = [];
	for (const arg of args) {
		values.push(await evaluateAsyncNode(arg, source, context, tools));
	}

	if (name === "sleep") {
		if (values.length !== 2) throw new Error("sleep() requires two arguments.");
		const milliseconds = javaInt32(values[0] ?? Number.NaN);
		if (milliseconds < 0) {
			throw new Error("Sleep duration must be a nonnegative integer.");
		}
		throwIfAborted(tools.signal);
		if (tools.delay) await tools.delay(milliseconds);
		else await javaRosaSleep(milliseconds, undefined, tools.signal);
		throwIfAborted(tools.signal);
		return values[1] ?? "";
	}
	if (name === "encrypt-string") {
		requireArity(name, values, 3);
		throwIfAborted(tools.signal);
		const encrypted = await (
			tools.encryptString ??
			((message, key, algorithm) =>
				javaRosaEncryptString(message, key, algorithm, {
					crypto: tools.crypto,
				}))
		)(
			xpathToString(values[0] ?? ""),
			xpathToString(values[1] ?? ""),
			xpathToString(values[2] ?? ""),
		);
		throwIfAborted(tools.signal);
		return encrypted;
	}
	if (name === "decrypt-string") {
		requireArity(name, values, 3);
		throwIfAborted(tools.signal);
		const decrypted = await (
			tools.decryptString ??
			((payload, key, algorithm) =>
				javaRosaDecryptString(payload, key, algorithm, {
					crypto: tools.crypto,
				}))
		)(
			xpathToString(values[0] ?? ""),
			xpathToString(values[1] ?? ""),
			xpathToString(values[2] ?? ""),
		);
		throwIfAborted(tools.signal);
		return decrypted;
	}
	if (name === "regex") {
		requireArity(name, values, 2);
		throwIfAborted(tools.signal);
		const pattern = await prepareOpenJdk17Pattern(
			xpathToString(values[1] ?? ""),
		);
		throwIfAborted(tools.signal);
		return javaRosaRegex(xpathToString(values[0] ?? ""), pattern);
	}
	if (name === "replace") {
		requireArity(name, values, 3);
		throwIfAborted(tools.signal);
		const pattern = await prepareOpenJdk17Pattern(
			xpathToString(values[1] ?? ""),
		);
		throwIfAborted(tools.signal);
		return javaRosaReplace(
			xpathToString(values[0] ?? ""),
			pattern,
			xpathToString(values[2] ?? ""),
		);
	}
	if (name === "position") {
		if (values.length > 1) {
			throw new Error("position() accepts zero or one argument.");
		}
		if (values.length === 1) {
			const selected = values[0];
			if (!isXPathNodeSet(selected)) {
				throw new Error("position(reference) requires a nodeset.");
			}
			const first = selected.nodes[0];
			if (!first) {
				throw new Error("Unable to evaluate position() on an empty reference.");
			}
			return first.multiplicity;
		}
		return context.position ?? context.contextNode?.multiplicity ?? 0;
	}

	const invocation = invokeFunction(name, values, { locale: context.locale });
	if (invocation.kind === "handled") return invocation.value;
	const generated = context.invokeGeneratedFunction?.(
		name,
		values.map(unpackXPathRuntimeValue),
	);
	if (generated?.kind === "handled") return generated.value;
	throw new Error(`Unsupported XPath function in Preview: ${name}()`);
}

async function evaluateAsyncFilter(
	node: SyntaxNode,
	source: string,
	context: EvalContext,
	tools: XPathAsyncEvaluationTools,
): Promise<XPathNodeSet> {
	const expressions = directExpressionChildren(node);
	const baseNode = expressions[0];
	const predicate = expressions[1];
	if (!baseNode || !predicate) return new XPathNodeSet([]);
	const base = await evaluateAsyncNode(baseNode, source, context, tools);
	if (!isXPathNodeSet(base)) {
		throw new Error(
			"Unsupported standalone XPath filter expression in JavaRosa.",
		);
	}
	const selected = [];
	for (let index = 0; index < base.candidates.length; index += 1) {
		const candidate = base.candidates[index];
		if (!candidate) continue;
		const value = await evaluateAsyncNode(
			predicate,
			source,
			xpathPredicateContext(context, candidate, index),
			tools,
		);
		if (xpathPredicateMatches(value, index)) selected.push(candidate);
	}
	return new XPathNodeSet(selected, base.validPath, base.schemaNodes);
}

function containsAsyncFunction(node: SyntaxNode, source: string): boolean {
	if (node.type.name === "Invoke") {
		const name = node.getChild("FunctionName");
		if (name && ASYNC_XPATH_FUNCTIONS.has(source.slice(name.from, name.to))) {
			return true;
		}
	}
	let child = node.firstChild;
	while (child) {
		if (containsAsyncFunction(child, source)) return true;
		child = child.nextSibling;
	}
	return false;
}

function argumentNodes(argumentList: SyntaxNode): SyntaxNode[] {
	const args: SyntaxNode[] = [];
	let child = argumentList.firstChild;
	while (child) {
		if (!["(", ")", ","].includes(child.type.name)) args.push(child);
		child = child.nextSibling;
	}
	return args;
}

function firstExpressionChild(node: SyntaxNode): SyntaxNode | undefined {
	let child = node.firstChild;
	while (child && ["(", ")"].includes(child.type.name)) {
		child = child.nextSibling;
	}
	return child ?? undefined;
}

function requireArity(
	name: string,
	values: readonly XPathRuntimeValue[],
	expected: number,
): void {
	if (values.length !== expected) {
		throw new Error(`${name}() requires ${expected} arguments.`);
	}
}

/** FunctionUtils.toInt(...).intValue(), used by Core's sleep(). */
function javaInt32(value: XPathRuntimeValue): number {
	const number = toNumber(value);
	if (Number.isNaN(number)) return 0;
	if (number >= 2_147_483_647) return 2_147_483_647;
	if (number <= -2_147_483_648) return -2_147_483_648;
	return Math.trunc(number);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	throw signal.reason ?? new DOMException("Cancelled", "AbortError");
}
