/**
 * Function capabilities by the runtime that actually consumes the text.
 *
 * These sets deliberately do not pretend that "XPath" is one language:
 * JavaRosa evaluates XForm and ordinary suite XPath on the device; Nova
 * Preview evaluates authored form XPath in the browser; and CCHQ parses CSQL
 * only after a case-search request reaches the server. A name in one carrier
 * says nothing about another.
 *
 * Frozen upstream evidence (2026-08-15):
 * - commcare-core 8e9ba8d908e95f4dc71c9ade0467c6ebfbfbd305
 *   ASTNodeFunctionCall.buildFuncExpr
 * - commcare-android 79d8418ab2dcd9846ae297c8f1edd189393b8e35
 *   EntitySelectActivity.installEvaluationFunctionHandlers
 * - formplayer 372832b36c715634d115b059eb561564885f4aae
 *   MenuSessionRunnerService.getEvaluationContext
 * - commcare-hq ef148302e5af566639779d76126de25064a55106
 *   corehq/apps/case_search/xpath_functions/__init__.py
 * - Vellum 8a1ef02df51fe1ce0d0ef1e83bfa04c032363e48
 *   src/parse.js / src/xpath.js (authoring round-trip, no runtime handlers)
 */

import type { SyntaxNode } from "@lezer/common";
import { parser } from "./parser";

/** Functions constructed directly by commcare-core's parser dispatch. */
export const JAVAROSA_NATIVE_FUNCTIONS: ReadonlySet<string> = new Set([
	"abs",
	"acos",
	"asin",
	"atan",
	"atan2",
	"boolean",
	"boolean-from-string",
	"ceiling",
	"checklist",
	"checksum",
	"closest-point-on-polygon",
	"coalesce",
	"concat",
	"cond",
	"contains",
	"cos",
	"count",
	"count-selected",
	"date",
	"decrypt-string",
	"depend",
	"distance",
	"distinct-values",
	"double",
	"encrypt-string",
	"ends-with",
	"exp",
	"false",
	"floor",
	"format-date",
	"format-date-for-calendar",
	"id-compress",
	"if",
	"index-of",
	"int",
	"is-point-inside-polygon",
	"is-selected",
	"join",
	"join-chunked",
	"json-property",
	"log",
	"log10",
	"lower-case",
	"max",
	"min",
	"not",
	"now",
	"number",
	"pi",
	"position",
	"pow",
	"random",
	"regex",
	"replace",
	"round",
	"selected",
	"selected-at",
	"sin",
	"sleep",
	"sort",
	"sort-by",
	"sqrt",
	"starts-with",
	"string",
	"string-length",
	"substr",
	"substring-after",
	"substring-before",
	"sum",
	"tan",
	"today",
	"translate",
	"true",
	"upper-case",
	"uuid",
	"weighted-checklist",
]);

/** Nova spellings with a proven source-to-source JavaRosa lowering. */
export const JAVAROSA_LOWERED_FUNCTIONS: ReadonlySet<string> = new Set([
	"normalize-space",
]);

/**
 * Parser intrinsics accepted only as the left root of a path. They are not
 * ordinary function calls in Core: XPathPathExpr recognizes them while
 * building the path reference.
 */
export const JAVAROSA_PATH_INITIALIZERS: ReadonlySet<string> = new Set([
	"current",
	"instance",
]);

/**
 * Runtime-injected handlers available only in their owning UI context. They
 * are not authorable XForm functions. Android and Formplayer install `here()`
 * while evaluating menu/detail entities, not while evaluating form binds.
 */
export const JAVAROSA_CONTEXT_FUNCTIONS: ReadonlySet<string> = new Set([
	"here",
]);

/** Functions Nova Preview currently implements rather than approximates. */
export const PREVIEW_NATIVE_FUNCTIONS: ReadonlySet<string> = new Set([
	"abs",
	"boolean",
	"ceiling",
	"coalesce",
	"concat",
	"contains",
	"count",
	"count-selected",
	"date",
	"double",
	"false",
	"floor",
	"format-date",
	"if",
	"int",
	"join",
	"max",
	"min",
	"normalize-space",
	"not",
	"now",
	"number",
	"position",
	"pow",
	"regex",
	"replace",
	"round",
	"selected",
	"selected-at",
	"starts-with",
	"string",
	"string-length",
	"substr",
	"sum",
	"today",
	"translate",
	"true",
	"uuid",
]);

/** Path roots the scalar Preview evaluator resolves faithfully. */
export const PREVIEW_PATH_INITIALIZERS: ReadonlySet<string> = new Set([
	"instance",
]);

/** CCHQ functions allowed in a CSQL value position. */
export const CSQL_VALUE_FUNCTIONS: ReadonlySet<string> = new Set([
	"date",
	"date-add",
	"datetime",
	"datetime-add",
	"double",
	"now",
	"today",
	"unwrap-list",
]);

/** CCHQ functions allowed as CSQL query nodes. */
export const CSQL_QUERY_FUNCTIONS: ReadonlySet<string> = new Set([
	"ancestor-exists",
	"fuzzy-date",
	"fuzzy-match",
	"match-all",
	"match-none",
	"not",
	"phonetic-match",
	"selected",
	"selected-all",
	"selected-any",
	"starts-with",
	"subcase-count",
	"subcase-exists",
	"within-distance",
]);

export type JavaRosaFunctionCapability =
	| "native"
	| "lowered"
	| "path-initializer"
	| "context-handler"
	| "unsupported";

export function javaRosaFunctionCapability(
	name: string,
): JavaRosaFunctionCapability {
	if (JAVAROSA_NATIVE_FUNCTIONS.has(name)) return "native";
	if (JAVAROSA_LOWERED_FUNCTIONS.has(name)) return "lowered";
	if (JAVAROSA_PATH_INITIALIZERS.has(name)) return "path-initializer";
	if (JAVAROSA_CONTEXT_FUNCTIONS.has(name)) return "context-handler";
	return "unsupported";
}

export function assertCsqlValueFunction(name: string): void {
	if (!CSQL_VALUE_FUNCTIONS.has(name)) {
		throw new Error(
			`Cannot emit ${name}() as CSQL: CCHQ does not register it as a value function.`,
		);
	}
}

export function assertCsqlQueryFunction(name: string): void {
	if (!CSQL_QUERY_FUNCTIONS.has(name)) {
		throw new Error(
			`Cannot emit ${name}() as CSQL: CCHQ does not register it as a query function.`,
		);
	}
}

export interface XPathFunctionCallCapability {
	readonly name: string;
	readonly from: number;
	readonly javaRosa: JavaRosaFunctionCapability;
	readonly preview: "native" | "path-initializer" | "unsupported";
	readonly validPathInitializer: boolean;
}

/**
 * Read function invocations structurally from the XPath CST. This powers
 * audits and artifact tests; callers never regex-parse expression text.
 */
export function inspectXPathFunctionCalls(
	source: string,
): XPathFunctionCallCapability[] {
	const calls: XPathFunctionCallCapability[] = [];
	const tree = parser.parse(source);
	const invokeType = parser.nodeSet.types.find(
		(type) => type.name === "Invoke",
	);
	const nameType = parser.nodeSet.types.find(
		(type) => type.name === "FunctionName",
	);
	if (invokeType === undefined || nameType === undefined) {
		throw new Error("XPath parser is missing function-call node types");
	}
	tree.iterate({
		enter(cursor) {
			if (cursor.type !== invokeType) return;
			const nameNode = cursor.node.getChild(nameType.id);
			if (nameNode === null) return;
			const name = source.slice(nameNode.from, nameNode.to);
			const javaRosa = javaRosaFunctionCapability(name);
			const validPathInitializer =
				javaRosa !== "path-initializer" ||
				(isPathInitializer(cursor.node) &&
					hasValidPathInitializerArguments(cursor.node, name));
			calls.push({
				name,
				from: nameNode.from,
				javaRosa,
				preview: PREVIEW_NATIVE_FUNCTIONS.has(name)
					? "native"
					: PREVIEW_PATH_INITIALIZERS.has(name)
						? "path-initializer"
						: "unsupported",
				validPathInitializer,
			});
		},
	});
	return calls;
}

function hasValidPathInitializerArguments(
	node: SyntaxNode,
	name: string,
): boolean {
	const args = node.getChild("ArgumentList");
	if (args === null) return false;
	const expressions: SyntaxNode[] = [];
	let child = args.firstChild;
	while (child !== null) {
		if (
			child.type.name !== "(" &&
			child.type.name !== ")" &&
			child.type.name !== ","
		) {
			expressions.push(child);
		}
		child = child.nextSibling;
	}
	if (name === "current") return expressions.length === 0;
	return (
		name === "instance" &&
		expressions.length === 1 &&
		expressions[0]?.type.name === "StringLiteral"
	);
}

function isPathInitializer(node: SyntaxNode): boolean {
	const parent = node.parent;
	if (
		parent === null ||
		(parent.type.name !== "Child" && parent.type.name !== "Descendant")
	) {
		return false;
	}
	const first = parent.firstChild;
	return first?.from === node.from && first.to === node.to;
}
