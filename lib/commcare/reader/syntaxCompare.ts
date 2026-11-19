/**
 * Whether two XPath texts are one expression to CommCare: both are read by
 * the one grammar (`xpath/formSyntax.ts`), normalized by the closed table of
 * spellings Core reads alike, and compared node for node. The table:
 *
 * - whitespace, between tokens: the grammar skips it, so no tree holds it.
 * - grouping: parentheses that group an operand: a `group` node is its value
 *   (`parser/Parser.java::parseParens`).
 * - quotes: `"x"` and `'x'`: a string compares by its value
 *   (`parser/Lexer.java::lex`, the `STR` token).
 * - numbers: `1`, `1.0`, `01`, `.5`, `0.5`: a number compares by its double
 *   (`Lexer.java::matchNumeric`, `Double.valueOf`).
 * - axes: `child::a` and `a`, `self::node()` and `.`, `parent::node()` and `..`
 *   (`expr/XPathStep.java` holds one axis and test for either spelling).
 *   `attribute::a` and `@a` are one `axis` node already.
 * - predicate-node: `./.` and `.` as the whole of a path inside a predicate: Core
 *   contextualizes both to the predicate's node.
 * - cond: in a record slot, `cond(c1, v1, …, cn, vn, d)` and
 *   `if(c1, v1, if(…, if(cn, vn, d)))` (`expr/XPathCondFunc.java::evalBody`
 *   stops at the first true test): the source's `cond` becomes nested `if`.
 * - is-selected: `is-selected(a, b)` and `selected(a, b)`: Core's parser
 *   builds one function for either name (`parser/ast/ASTNodeFunctionCall.java`,
 *   `selected` falling through to `is-selected` and `XPathSelectedFunc`): the
 *   source's `is-selected` becomes `selected`.
 *
 * A case row's `name` step is no spelling of `case_name`: Core's `casedb`
 * holds the case's name as `case_name` and answers any other step with a
 * blank node (`CaseChildElement.getChildrenWithName`), so the two are two
 * reads and compare as two trees.
 *
 * Nothing else is erased: `a and (b and c)` and `a and b and c` are two
 * trees, as are `a != b` and `not(a = b)`. Source spans are never compared.
 * This file reads no reader state: the form, case, menu and list readers call
 * it before any expression is bound.
 */
import type { RuleSet } from "@/lib/domain/expression/profiles";
import type { FormSyntax } from "../xpath/formSyntax";
import { readFormSyntax } from "./syntaxRead";

export interface CompareOptions {
	/** `record` reads `cond` as nested `if`; `form` never does. */
	readonly ruleSet: RuleSet;
	/** Maps a form's own instance id, in the source tree, to Nova's id for the same source. */
	readonly instanceId?: (id: string) => string;
	/** Maps HQ's itext id, in the source tree, to Nova's id for the same text unit. */
	readonly itextId?: (id: string) => string;
}

const RECORD: CompareOptions = { ruleSet: "record" };

/** Where a node sits: inside a predicate (where `./.` is `.`) or not. */
interface Position {
	readonly predicate: boolean;
}

/** `options` defaults to `{ ruleSet: "record" }`, the comparison a call
 *  with two arguments means. */
export function sameSyntax(
	source: FormSyntax,
	print: FormSyntax,
	options: CompareOptions = RECORD,
): boolean {
	return firstDifference(source, print, options) === undefined;
}

/** The source node at which the two trees first differ, in document order. */
export function firstDifference(
	source: FormSyntax,
	print: FormSyntax,
	options: CompareOptions,
): FormSyntax | undefined {
	return difference(
		comparable(source, options, "source"),
		comparable(print, options, "print"),
	);
}

/** Two texts that parse to the same tree. Used by the list and menu readers.
 *  A text the syntax reader cannot read compares unlike anything, as
 *  `hqInterpolation.ts::syntaxOf` answers it. */
export function sameXPathText(
	a: string,
	b: string,
	options: CompareOptions = RECORD,
): boolean {
	const left = readSyntax(a);
	const right = readSyntax(b);
	if (left === undefined || right === undefined) return false;
	if (!left.ok || !right.ok) return false;
	if (left.node === undefined || right.node === undefined)
		return left.node === right.node;
	return sameSyntax(left.node, right.node, options);
}

function readSyntax(
	text: string,
): ReturnType<typeof readFormSyntax> | undefined {
	try {
		return readFormSyntax(text);
	} catch {
		return undefined;
	}
}

/** A tree normalized by the table. The source side alone takes the local
 *  name maps, the `cond` row and the `is-selected` row, since Nova's print
 *  spells its own names, never writes `cond` in a record slot and never writes
 *  `is-selected`. */
function comparable(
	node: FormSyntax,
	options: CompareOptions,
	side: "source" | "print",
): FormSyntax {
	const normalize = (at: FormSyntax, position: Position): FormSyntax => {
		switch (at.kind) {
			case "group":
				return normalize(at.value, position);
			case "axis":
				if (at.axis === "child") return normalize(at.value, position);
				if (
					(at.axis === "self" || at.axis === "parent") &&
					at.value.kind === "call" &&
					at.value.name === "node" &&
					at.value.args.length === 0
				)
					return { kind: at.axis, from: at.from, to: at.to };
				return { ...at, value: normalize(at.value, position) };
			case "negative":
				return { ...at, value: normalize(at.value, position) };
			case "binary":
				return {
					...at,
					left: normalize(at.left, position),
					right: normalize(at.right, position),
				};
			case "child": {
				const left =
					at.left === undefined ? undefined : normalize(at.left, position);
				const step = normalize(at.step, position);
				if (
					position.predicate &&
					!at.descendant &&
					left?.kind === "self" &&
					step.kind === "self"
				)
					return { kind: "self", from: at.from, to: at.to };
				return {
					...at,
					...(left === undefined ? {} : { left }),
					step,
				};
			}
			case "filter":
				return {
					...at,
					base: normalize(at.base, position),
					where: normalize(at.where, { predicate: true }),
				};
			case "call": {
				if (side === "source") {
					if (
						options.ruleSet === "record" &&
						at.name === "cond" &&
						at.args.length >= 3 &&
						at.args.length % 2 === 1
					)
						return normalize(nestedIf(at), position);
					if (at.name === "is-selected" && at.args.length === 2)
						return {
							...at,
							name: "selected",
							args: at.args.map((arg) => normalize(arg, position)),
						};
					if (
						at.name === "instance" &&
						at.args.length === 1 &&
						at.args[0].kind === "string" &&
						options.instanceId !== undefined
					)
						return {
							...at,
							args: [
								{ ...at.args[0], value: options.instanceId(at.args[0].value) },
							],
						};
					if (
						at.name === "jr:itext" &&
						at.args.length === 1 &&
						at.args[0].kind === "string" &&
						options.itextId !== undefined
					)
						return {
							...at,
							args: [
								{ ...at.args[0], value: options.itextId(at.args[0].value) },
							],
						};
				}
				return {
					...at,
					args: at.args.map((arg) => normalize(arg, position)),
				};
			}
			default:
				return at;
		}
	};
	return normalize(node, { predicate: false });
}

/** `cond(c1, v1, …, cn, vn, d)` as the nested `if` it equals, each synthetic
 *  call spanning the `cond`. */
function nestedIf(node: Extract<FormSyntax, { kind: "call" }>): FormSyntax {
	const args = node.args;
	let result = args[args.length - 1];
	for (let index = args.length - 3; index >= 0; index -= 2)
		result = {
			kind: "call",
			name: "if",
			args: [args[index], args[index + 1], result],
			from: node.from,
			to: node.to,
		};
	return result;
}

/** The first source node, in document order, whose pair differs. */
function difference(
	source: FormSyntax,
	print: FormSyntax,
): FormSyntax | undefined {
	if (source.kind !== print.kind) return source;
	const children = (
		left: readonly (FormSyntax | undefined)[],
		right: readonly (FormSyntax | undefined)[],
	): FormSyntax | undefined => {
		if (left.length !== right.length) return source;
		for (let index = 0; index < left.length; index++) {
			const a = left[index];
			const b = right[index];
			if (a === undefined || b === undefined) {
				if (a !== b) return source;
				continue;
			}
			const found = difference(a, b);
			if (found !== undefined) return found;
		}
		return undefined;
	};
	switch (source.kind) {
		case "string":
		case "number":
			return print.kind === source.kind && print.value === source.value
				? undefined
				: source;
		case "name":
			return print.kind === "name" &&
				print.name === source.name &&
				print.wildcard === source.wildcard
				? undefined
				: source;
		case "hashtag":
			return print.kind === "hashtag" &&
				print.namespace === source.namespace &&
				print.segments.length === source.segments.length &&
				print.segments.every(
					(segment, index) => segment === source.segments[index],
				)
				? undefined
				: source;
		case "self":
		case "parent":
		case "root":
			return undefined;
		case "variable":
			return print.kind === "variable" && print.name === source.name
				? undefined
				: source;
		case "group":
		case "negative":
			return print.kind === source.kind
				? children([source.value], [print.value])
				: source;
		case "axis":
			return print.kind === "axis" && print.axis === source.axis
				? children([source.value], [print.value])
				: source;
		case "child":
			return print.kind === "child" && print.descendant === source.descendant
				? children([source.left, source.step], [print.left, print.step])
				: source;
		case "filter":
			return print.kind === "filter"
				? children([source.base, source.where], [print.base, print.where])
				: source;
		case "binary":
			return print.kind === "binary" && print.op === source.op
				? children([source.left, source.right], [print.left, print.right])
				: source;
		case "call":
			return print.kind === "call" && print.name === source.name
				? children(source.args, print.args)
				: source;
	}
}
