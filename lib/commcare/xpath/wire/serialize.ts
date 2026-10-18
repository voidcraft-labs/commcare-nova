import { decodeHTML } from "entities";
import { formatNumeric } from "../../predicate/stringQuoting";
import { keyAsVariable } from "../../suite/case-list/keyVariable";
import { w } from "./builders";
import { InstanceSink } from "./instances";
import type {
	NonShadowWireMode,
	SerializedWire,
	WireExpr,
	WireMode,
	WirePath,
	WireStep,
} from "./tree";

// These examine literal VALUES, never XPath structure. Python's regex also
// treats U+0085 and the four information separators as whitespace.
// biome-ignore lint/suspicious/noControlCharactersInRegex: HQ's Python whitespace class includes these decoded characters.
const INSTANCE_LITERAL = /instance\([\s\u001c-\u001f\u0085]*['"]/gu;
const INTERPOLATION_LITERAL = /#(?:user|session\/|case|parent|host)/gu;
// localName from grammar.lezer.grammar. Endpoint arguments are generated datum
// identities, never an authored arbitrary variable or a qualified name.
const NAME_START =
	"A-Za-z_\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD";
const ENDPOINT_ARGUMENT_NAME = new RegExp(
	`^[${NAME_START}][${NAME_START}0-9.\\-\\u00B7\\u0300-\\u036F\\u203F-\\u2040]*$`,
	"u",
);

/** Python html.unescape has the HTML5 named table but drops certain numeric
 * references that browser decoders retain. Read each original reference once,
 * as Python does: a decoded ampersand never begins another decoding pass. */
function hqHtmlUnescape(value: string): string {
	return value.replace(
		/&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/gu,
		(reference: string) => {
			if (reference.startsWith("&#")) {
				const hex = reference[2] === "x" || reference[2] === "X";
				const codepoint = Number.parseInt(
					reference.slice(hex ? 3 : 2),
					hex ? 16 : 10,
				);
				if (
					(codepoint >= 1 && codepoint <= 8) ||
					codepoint === 11 ||
					(codepoint >= 14 && codepoint <= 31) ||
					codepoint === 127 ||
					(codepoint >= 0xfdd0 && codepoint <= 0xfdef) ||
					(codepoint <= 0x10ffff && (codepoint & 0xffff) >= 0xfffe)
				)
					return "";
			}
			return decodeHTML(reference);
		},
	);
}

function hashtagInterpolationRuns(mode: WireMode): boolean {
	return (
		mode.target === "hq-json" &&
		mode.interpolation !== "none" &&
		mode.interpolation !== "enum-key"
	);
}

function literalPieces(value: string, mode: WireMode): string[] {
	const cuts = new Set<number>();
	const hqBound =
		mode.target === "xform" ||
		mode.target === "vellum" ||
		mode.target === "hq-json";
	if (hqBound) {
		for (const match of value.matchAll(INSTANCE_LITERAL))
			cuts.add(match.index + "instance".length);
	}
	// HQ reads raw JSON XPath through html.unescape before its instance regex.
	// Splitting the original ampersands preserves the value while preventing a
	// single unescape from constructing an instance call across literal tokens.
	if (
		mode.target === "hq-json" &&
		[...hqHtmlUnescape(value).matchAll(INSTANCE_LITERAL)].length > 0
	) {
		for (let index = 0; index < value.length; index++)
			if (value[index] === "&") cuts.add(index + 1);
	}
	if (hashtagInterpolationRuns(mode)) {
		for (const match of value.matchAll(INTERPOLATION_LITERAL))
			cuts.add(match.index + 1);
	}
	const pieces: string[] = [];
	let previous = 0;
	for (const cut of [...cuts].sort((a, b) => a - b)) {
		pieces.push(value.slice(previous, cut));
		previous = cut;
	}
	pieces.push(value.slice(previous));
	return pieces;
}

/** Core has no quote escape. HQ alone gives backslashes lexical meaning.
 * A concat argument keeps empty quote-split pieces so its generated scaffold
 * has the same argument boundaries as the original constant segment. */
function literalTokens(
	value: string,
	mode: WireMode,
	keepEmptyQuotePieces: boolean,
): string[] {
	const tokens: string[] = [];
	const quote = (piece: string) => {
		let trailing = 0;
		for (
			let index = piece.length - 1;
			index >= 0 && piece[index] === "\\";
			index--
		)
			trailing++;
		// MappingItem.key_as_condition only calls dot_interpolate, without
		// hashtag replacements. It still uses the same backslash-aware lexer.
		const needsLastBackslash =
			mode.target === "hq-json" &&
			mode.interpolation !== "none" &&
			trailing % 2 === 1;
		const safe = needsLastBackslash ? piece.slice(0, -1) : piece;
		if (safe.length > 0 || !needsLastBackslash)
			tokens.push(safe.includes("'") ? `"${safe}"` : `'${safe}'`);
		if (needsLastBackslash) tokens.push("substr('\\\\', 0, 1)");
	};
	for (const piece of literalPieces(value, mode)) {
		if (!piece.includes("'") || !piece.includes('"')) {
			quote(piece);
			continue;
		}
		const parts = piece.split("'");
		for (let index = 0; index < parts.length; index++) {
			if (keepEmptyQuotePieces || parts[index].length > 0) quote(parts[index]);
			if (index < parts.length - 1) quote("'");
		}
	}
	return tokens;
}

function printLiteral(value: string, mode: WireMode): string {
	const tokens = literalTokens(value, mode, false);
	return tokens.length === 1 ? tokens[0] : `concat(${tokens.join(", ")})`;
}

function transparent(expr: WireExpr): WireExpr {
	return expr.k === "expansion" ? transparent(expr.expr) : expr;
}

function precedence(expr: WireExpr): number {
	const node = transparent(expr);
	switch (node.k) {
		case "or":
			return 1;
		case "and":
			return 2;
		case "cmp":
			return node.op === "=" || node.op === "!=" ? 3 : 4;
		case "arith":
			return node.op === "+" || node.op === "-" ? 5 : 6;
		case "neg":
			return 7;
		case "num":
			return node.value < 0 ? 7 : 9;
		case "path":
			return 8;
		default:
			return 9;
	}
}

function children(expr: WireExpr): readonly WireExpr[] {
	switch (expr.k) {
		case "cmp":
		case "arith":
			return [expr.left, expr.right];
		case "and":
		case "or":
			return expr.items;
		case "neg":
			return [expr.value];
		case "call":
			return expr.args;
		case "path":
			return expr.steps.flatMap((step) => step.predicates);
		case "expansion":
			return [expr.expr];
		default:
			return [];
	}
}

function withholdsShadow(
	expr: WireExpr,
	visited = new WeakSet<WireExpr>(),
): boolean {
	if (visited.has(expr)) return false;
	visited.add(expr);
	if (expr.k === "expansion") return true;
	if (expr.k === "path") {
		if (expr.root.k === "hq-case") return true;
		if (
			expr.root.k === "form" &&
			expr.root.spelling === "hashtag" &&
			expr.steps.some(
				(step) => step.axis !== "child" || step.predicates.length > 0,
			)
		)
			return true;
	}
	return children(expr).some((child) => withholdsShadow(child, visited));
}

function stepName(step: WireStep): string {
	if (step.axis === "self") return ".";
	if (step.axis === "parent") return "..";
	if (step.axis === "wildcard") return "*";
	// Names are resolved identities, never serialized paths or wildcard text.
	if (!step.name || /[\s/[\]()'"*=<>]/u.test(step.name))
		throw new Error("A wire path step must hold one resolved XML name.");
	return `${step.axis === "attribute" ? "@" : ""}${step.name}`;
}

export function serializeWire(
	expr: WireExpr,
	mode: NonShadowWireMode,
): SerializedWire;
export function serializeWire(
	expr: WireExpr,
	mode: WireMode,
): SerializedWire | undefined;
export function serializeWire(
	expr: WireExpr,
	mode: WireMode,
): SerializedWire | undefined {
	if (mode.target === "vellum" && withholdsShadow(expr)) return undefined;
	const instances = new InstanceSink();
	const ordinary = new WeakMap<WireExpr, string>();
	const predicate = new WeakMap<WireExpr, string>();

	function operand(
		child: WireExpr,
		parent: WireExpr,
		right: boolean,
		inPredicate: boolean,
	): string {
		const printed = print(child, inPredicate);
		const sameLogical =
			(parent.k === "and" || parent.k === "or") &&
			transparent(child).k === parent.k;
		return precedence(child) < precedence(parent) ||
			(right && precedence(child) === precedence(parent) && !sameLogical)
			? `(${printed})`
			: printed;
	}

	function printPath(node: WirePath, inPredicate: boolean): string {
		const dotInterpolated =
			mode.target === "hq-json" &&
			(mode.interpolation === "case" || mode.interpolation === "no-case");
		if (
			dotInterpolated &&
			((node.root.k === "context" && node.steps.length === 0) ||
				node.steps.some(
					(step) => step.axis === "self" || step.axis === "parent",
				))
		)
			throw new Error(
				"An HQ-interpolated XPath cannot contain a self or parent step.",
			);
		if (
			mode.target === "hq-json" &&
			mode.interpolation === "enum-key" &&
			node.steps.some((step) => step.axis === "parent")
		) {
			throw new Error(
				"An HQ enum key may use a self placeholder, but cannot contain a parent step.",
			);
		}
		let root: string;
		switch (node.root.k) {
			case "form":
				root =
					mode.target === "vellum" && node.root.spelling === "hashtag"
						? "#form"
						: "/data";
				break;
			case "context":
				root = "";
				break;
			case "current":
				root = "current()";
				break;
			case "instance":
				instances.addOne(node.root.decl);
				root = `instance(${printLiteral(node.root.decl.id, mode)})`;
				break;
			case "hq-case":
				if (mode.target !== "hq-json" || mode.interpolation !== "case")
					throw new Error(
						"The HQ case shortcut is available only in a case-interpolated HQ JSON slot.",
					);
				root = "#case";
				break;
		}
		const protectSelf =
			inPredicate &&
			(mode.target === "xform" || mode.target === "vellum") &&
			!mode.constraint &&
			node.root.k === "context" &&
			(node.steps.length === 0 ||
				(node.steps.length === 1 && node.steps[0].axis === "self"));
		if (node.steps.length === 0) return root || (protectSelf ? "./." : ".");
		const steps = node.steps
			.map(
				(step) =>
					`${protectSelf ? "./." : stepName(step)}${step.predicates.map((condition) => `[${print(condition, true)}]`).join("")}`,
			)
			.join("/");
		return root ? `${root}/${steps}` : steps;
	}

	function suiteVariable(name: string): string {
		if (mode.target !== "suite")
			throw new Error(
				"A generated suite variable cannot be emitted outside a suite slot.",
			);
		return `$${name}`;
	}

	function print(node: WireExpr, inPredicate: boolean): string {
		const cache = inPredicate ? predicate : ordinary;
		const prior = cache.get(node);
		if (prior !== undefined) return prior;
		let result: string;
		switch (node.k) {
			case "str":
				result = printLiteral(node.value, mode);
				break;
			case "num":
				if (!Number.isFinite(node.value))
					throw new Error("A wire number must be finite.");
				result = formatNumeric(node.value);
				break;
			case "cmp":
			case "arith":
				result = `${operand(node.left, node, false, inPredicate)} ${node.op} ${operand(node.right, node, true, inPredicate)}`;
				break;
			case "and":
			case "or":
				result = node.items
					.map((item, index) => operand(item, node, index > 0, inPredicate))
					.join(` ${node.k} `);
				break;
			case "neg":
				result = `-${operand(node.value, node, true, inPredicate)}`;
				break;
			case "call":
				result = `${node.fn}(${node.args
					.flatMap((arg) =>
						// Only a literal's encoding contributes argument tokens. An
						// actual nested concat retains its runtime tree structure.
						node.fn === "concat" && arg.k === "str"
							? literalTokens(arg.value, mode, true)
							: [print(arg, inPredicate)],
					)
					.join(", ")})`;
				break;
			case "path":
				result = printPath(node, inPredicate);
				break;
			case "expansion":
				result = print(node.expr, inPredicate);
				break;
			case "case-id-var":
				result = suiteVariable("case_id");
				break;
			case "next-input-var":
				result = suiteVariable("next_input");
				break;
			case "calculated-property-var":
				result = suiteVariable("calculated_property");
				break;
			case "enum-label-var":
				result = suiteVariable(`knova_text_${node.index}`);
				break;
			case "image-alt-var":
				result = suiteVariable(
					keyAsVariable(
						serializeWire(
							w.call("selected", [w.context([w.self()]), w.str(node.value)]),
							{ target: "hq-json", interpolation: "enum-key" },
						).text,
					),
				);
				break;
			case "hq-enum-var":
				if (mode.target !== "hq-json")
					throw new Error(
						"An HQ enum placeholder cannot be emitted outside an HQ JSON slot.",
					);
				result = `$nova_text_${node.index.toString(10).padStart(10, "0")}`;
				break;
			case "endpoint-argument-var":
				if (!ENDPOINT_ARGUMENT_NAME.test(node.name))
					throw new Error(
						"A generated endpoint argument must have an XPath local name.",
					);
				result = suiteVariable(node.name);
				break;
			default:
				throw new Error(
					`Unknown wire expression: ${String(node satisfies never)}.`,
				);
		}
		cache.set(node, result);
		return result;
	}

	const text = print(expr, false);
	return { text, instances: new Set(instances.declarations()) };
}
