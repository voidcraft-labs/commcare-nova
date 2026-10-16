/**
 * Form logic that orders a time of day.
 *
 * Core turns both sides of `<`, `<=`, `>` and `>=` into numbers, and a string
 * holding any character but a digit, `-` or `.` is NaN, so an ordering on a
 * time of day is never true on a device (commcare-core
 * `XPathCmpExpr.evalRaw`, `FunctionUtils.toNumeric`). A string literal holding
 * `:` is NaN the same way, a date and time written as text among them.
 *
 * The expression is printed and parsed with the Lezer grammar; structure is
 * read only through it. A stored reference leaf is found by its span in the
 * printed text, which is the printed length of the parts before it, since
 * `projectXPath` prints part by part. An operand is a time when it is a
 * reference to a time question, to a hidden value whose calculate is a time,
 * or to a case property whose effective type is `time`; a string literal
 * holding `:`; an `if(...)` or `coalesce(...)` with a branch that is a time;
 * or a parenthesized time. Everything else is not a time. This is the reading
 * `proof/checks/manifest_value_classes.py::time_operand` applies to the
 * emitted form.
 *
 * A finding names its ordering's place among the expression's orderings, so
 * an editor can find the same ordering in the text a person typed, whose
 * references may print at another length (`orderingSpans`).
 */

import type { SyntaxNode } from "@lezer/common";
import {
	type BlueprintDoc,
	effectiveCaseTypes,
	projectXPath,
	type Uuid,
	type XPathExpression,
	type XPathPart,
	type XPathPrintContext,
	xpathPrintContext,
} from "@/lib/domain";
import { parser } from "../xpath/parser";

export interface TimeOrderingFinding {
	readonly from: number;
	readonly to: number;
	readonly operator: "<" | "<=" | ">" | ">=";
	/** The ordering's index among every ordering in the expression, in
	 * document order, time or not. */
	readonly ordinal: number;
}

export interface TimeOrderingContext {
	readonly doc: BlueprintDoc;
	readonly formUuid?: Uuid;
}

const ORDERING_NODES: Readonly<
	Record<string, TimeOrderingFinding["operator"]>
> = {
	LessThanExpr: "<",
	LessEqualExpr: "<=",
	GreaterThanExpr: ">",
	GreaterEqualExpr: ">=",
};

/** The message of `XPATH_TIME_ORDERING`, for every carrier. */
export const TIME_ORDERING_MESSAGE =
	"This comparison has a time of day, or text holding a colon, on one side. CommCare compares before and after as numbers, so it would never be true.";

/**
 * Every ordering in `expression` with a time on either side, outermost
 * first, as spans of the printed text.
 */
export function findTimeOrderingComparisons(
	expression: XPathExpression,
	context: TimeOrderingContext,
): readonly TimeOrderingFinding[] {
	const reader = timeReader(context.doc);
	const printed = reader.print(expression);
	const findings: TimeOrderingFinding[] = [];
	let ordinal = 0;
	parser.parse(printed.text).iterate({
		enter: (node) => {
			const operator = ORDERING_NODES[node.name];
			if (operator === undefined) return;
			const [left, right] = comparisonOperands(node.node);
			if (
				(left !== undefined && reader.isTime(left, printed)) ||
				(right !== undefined && reader.isTime(right, printed))
			) {
				findings.push({ from: node.from, to: node.to, operator, ordinal });
			}
			ordinal++;
		},
	});
	return findings;
}

/**
 * Every ordering in `text`, in document order, as spans of that text: the
 * places a finding's `ordinal` indexes. A reference is one operand however
 * it is spelled, so the text a person typed and the text its stored
 * expression prints hold the same orderings in the same order.
 */
export function orderingSpans(
	text: string,
): ReadonlyArray<{ from: number; to: number }> {
	const spans: { from: number; to: number }[] = [];
	parser.parse(text).iterate({
		enter: (node) => {
			if (ORDERING_NODES[node.name] !== undefined) {
				spans.push({ from: node.from, to: node.to });
			}
		},
	});
	return spans;
}

/* A document is an immutable snapshot, so what the reader derives from it
 * (the print context's resolution cache, the case properties whose type is
 * a time) is built once per document and shared by every slot. */
const TIME_READERS = new WeakMap<BlueprintDoc, TimeReader>();

function timeReader(doc: BlueprintDoc): TimeReader {
	let reader = TIME_READERS.get(doc);
	if (reader === undefined) {
		reader = new TimeReader(doc);
		TIME_READERS.set(doc, reader);
	}
	return reader;
}

interface PrintedExpression {
	readonly text: string;
	/** Each reference leaf by its printed span, `from:to`. */
	readonly leaves: ReadonlyMap<string, XPathPart>;
}

/**
 * The two operand nodes of a comparison: the children before and after its
 * operator token, with a parenthesized operand unwrapped to its inner node.
 */
function comparisonOperands(
	node: SyntaxNode,
): [SyntaxNode | undefined, SyntaxNode | undefined] {
	const children = childrenOf(node);
	const operatorIndex = children.findIndex((child) =>
		["<", "<=", ">", ">="].includes(child.name),
	);
	if (operatorIndex === -1) return [undefined, undefined];
	return [
		innerOperand(children.slice(0, operatorIndex)),
		innerOperand(children.slice(operatorIndex + 1)),
	];
}

/** The one expression node among an operand's children, past its parens. */
function innerOperand(children: readonly SyntaxNode[]): SyntaxNode | undefined {
	const inner = children.filter(
		(child) => child.name !== "(" && child.name !== ")",
	);
	return inner.length === 1 ? inner[0] : undefined;
}

/** The argument nodes of a call, in order. */
function callArguments(invoke: SyntaxNode): SyntaxNode[] {
	const list = invoke.getChild("ArgumentList");
	if (list === null) return [];
	const args: SyntaxNode[] = [];
	for (let child = list.firstChild; child !== null; child = child.nextSibling) {
		if (child.name === "(" || child.name === ")" || child.name === ",")
			continue;
		args.push(child);
	}
	return args;
}

class TimeReader {
	private readonly timeProperties: ReadonlySet<string>;
	private readonly printContext: XPathPrintContext;
	/** The hidden values whose calculate is being read, to stop at a cycle.
	 * Empty between calls, so one reader serves every slot of its document. */
	private readonly visiting = new Set<string>();

	constructor(private readonly doc: BlueprintDoc) {
		this.printContext = xpathPrintContext(doc);
		this.timeProperties = new Set(
			effectiveCaseTypes(doc).flatMap((caseType) =>
				caseType.properties
					.filter((property) => property.data_type === "time")
					.map((property) => `${caseType.name}/${property.name}`),
			),
		);
	}

	print(expression: XPathExpression): PrintedExpression {
		const leaves = new Map<string, XPathPart>();
		let text = "";
		for (const part of expression.parts) {
			const printed = projectXPath({ parts: [part] }, this.printContext).text;
			if (part.kind !== "text") {
				leaves.set(`${text.length}:${text.length + printed.length}`, part);
			}
			text += printed;
		}
		return { text, leaves };
	}

	isTime(node: SyntaxNode, printed: PrintedExpression): boolean {
		const leaf = printed.leaves.get(`${node.from}:${node.to}`);
		if (leaf !== undefined) return this.leafIsTime(leaf);
		switch (node.name) {
			case "StringLiteral":
				return printed.text.slice(node.from, node.to).includes(":");
			case "Invoke": {
				const name = node.getChild("FunctionName");
				const fn = name === null ? "" : printed.text.slice(name.from, name.to);
				const args = callArguments(node);
				const branches =
					fn === "if" ? args.slice(1) : fn === "coalesce" ? args : [];
				return branches.some((branch) => this.isTime(branch, printed));
			}
			default:
				return false;
		}
	}

	/** Whether a whole stored expression's value is a time. */
	private expressionIsTime(expression: XPathExpression): boolean {
		const printed = this.print(expression);
		const top = parser.parse(printed.text).topNode;
		const inner = innerOperand(childrenOf(top));
		return inner !== undefined && this.isTime(inner, printed);
	}

	private leafIsTime(leaf: XPathPart): boolean {
		switch (leaf.kind) {
			case "field-ref":
			case "path-ref": {
				const field = this.doc.fields[leaf.uuid];
				if (field === undefined) return false;
				if (field.kind === "time") return true;
				if (field.kind !== "hidden" || field.calculate === undefined) {
					return false;
				}
				if (this.visiting.has(field.uuid)) return false;
				this.visiting.add(field.uuid);
				try {
					return this.expressionIsTime(field.calculate);
				} finally {
					this.visiting.delete(field.uuid);
				}
			}
			case "case-ref":
				return this.timeProperties.has(`${leaf.caseType}/${leaf.property}`);
			default:
				return false;
		}
	}
}

function childrenOf(node: SyntaxNode): SyntaxNode[] {
	const children: SyntaxNode[] = [];
	for (let child = node.firstChild; child !== null; child = child.nextSibling) {
		children.push(child);
	}
	return children;
}
