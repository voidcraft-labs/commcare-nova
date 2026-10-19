/**
 * The one printer of CSQL text, and the clause wrapper around it.
 *
 * `printCsql` turns a CSQL tree (`tree.ts`) into the segment list the
 * `_xpath_query` wrapper is built from: constant CSQL text, and runtime
 * segments that splice an on-device value in. `csqlClauseWrapper` builds the
 * wrapper itself as a wire tree, the shortest correct shape:
 *
 *   1. constant text alone, a bare XPath string literal;
 *   2. one quoted runtime string and nothing else, the flat quote cascade;
 *   3. otherwise `if(<or of obligations>, 'match-none()', concat(…))`, so a
 *      value no CSQL literal can hold fails the whole row closed.
 *
 * A clause rooted at `when-input-present` is the flat presence cascade
 * `if(count(<input>), <clause>, 'match-all()')`, its guards inside the
 * presence branch.
 */
import { formatNumeric } from "@/lib/domain/expression/numberLiteral";
import { w } from "../xpath/wire/builders";
import type { WireExpr } from "../xpath/wire/tree";
import {
	type CsqlSegment,
	dedupeRuntimeRejections,
	type RuntimeCsqlRejection,
} from "./segment";
import type { CsqlNode, CsqlObligation, CsqlRuntimeHole } from "./tree";

/**
 * The on-device wrapper that builds one `_xpath_query` value at run time, and
 * the obligations it enforces. Prompt validation
 * (`xpathQuery.ts::buildRuntimeCsqlPromptValidations`) and Preview evaluate
 * each obligation's condition, so every surface rejects the same runtime state
 * before dispatch where a worker can repair it.
 */
export interface CsqlEmissionResult {
	readonly wrapper: WireExpr;
	readonly runtimeRejections?: readonly RuntimeCsqlRejection[];
}

/** CSQL has no escape in its string literals (`eulxml/xpath/lexrules.py::t_LITERAL`). */
export function isCsqlStringLiteralRepresentable(value: string): boolean {
	return !(value.includes("'") && value.includes('"'));
}

/** A CSQL string literal: single quotes, double where the value holds one. */
export function quoteLiteral(value: string, _dialect: "csql"): string {
	if (!value.includes("'")) return `'${value}'`;
	if (!isCsqlStringLiteralRepresentable(value)) {
		throw new Error(
			`csql/print: CSQL has no portable escape for a string literal containing both ' and ". Got: ${JSON.stringify(value)}.`,
		);
	}
	return `"${value}"`;
}

const PREC_OR = 1;
const PREC_AND = 2;

/** The segments of one CSQL tree, adjacent constants merged. */
export function printCsql(tree: CsqlNode): CsqlSegment[] {
	const out: CsqlSegment[] = [];
	print(tree, 0, out);
	return mergeAdjacentConstants(out);
}

/** The `_xpath_query` wrapper of one clause. */
export function csqlClauseWrapper(tree: CsqlNode): CsqlEmissionResult {
	if (tree.k === "presence") {
		const trigger = w.call("count", [tree.trigger]);
		const inner = csqlClauseWrapper(tree.clause);
		const wrapper = w.call("if", [
			trigger,
			inner.wrapper,
			w.str("match-all()"),
		]);
		if (
			inner.runtimeRejections === undefined ||
			inner.runtimeRejections.length === 0
		)
			return { wrapper };
		// While the input is empty the clause is not used, so its obligations
		// must not reject an otherwise valid search.
		return {
			wrapper,
			runtimeRejections: inner.runtimeRejections.map((rejection) => ({
				...rejection,
				condition: w.and(trigger, rejection.condition),
			})),
		};
	}
	return wrapSegments(printCsql(tree));
}

function text(out: CsqlSegment[], value: string): void {
	out.push({ kind: "constant", text: value });
}

function print(node: CsqlNode, prec: number, out: CsqlSegment[]): void {
	switch (node.k) {
		case "cmp":
			print(node.left, 0, out);
			text(out, ` ${node.op} `);
			print(node.right, 0, out);
			return;
		case "and":
		case "or": {
			const own = node.k === "and" ? PREC_AND : PREC_OR;
			const open = prec > own;
			if (open) text(out, "(");
			node.items.forEach((item, index) => {
				if (index > 0) text(out, ` ${node.k} `);
				print(item, own, out);
			});
			if (open) text(out, ")");
			return;
		}
		case "not":
			text(out, "not(");
			print(node.item, 0, out);
			text(out, ")");
			return;
		case "group":
			text(out, "(");
			print(node.item, 0, out);
			text(out, ")");
			return;
		case "query-call":
		case "value-call":
			text(out, `${node.fn}(`);
			node.args.forEach((arg, index) => {
				if (index > 0) text(out, ", ");
				print(arg, 0, out);
			});
			text(out, ")");
			return;
		case "step":
			text(out, node.path.join("/"));
			return;
		case "literal":
			text(out, quoteLiteral(node.value, "csql"));
			return;
		case "number":
			text(out, formatNumeric(node.value));
			return;
		case "json-list":
			text(out, "'[");
			node.items.forEach((item, index) => {
				if (index > 0) text(out, ",");
				if (item.k === "item")
					// `json.loads` restores the escaped quote, so the single-quoted
					// CSQL literal never holds one.
					text(out, JSON.stringify(item.value).replaceAll("'", "\\u0027"));
				else hole(item.hole, out);
			});
			text(out, "]'");
			return;
		case "runtime":
			hole(node.hole, out);
			return;
		case "guarded":
			print(node.item, prec, out);
			out.push(carrier(node.obligation));
			return;
		case "choice":
			choice(node.key, node.condition, node.then, node.else, out);
			return;
		case "presence":
			choice(
				node.key,
				w.call("count", [node.trigger]),
				node.clause,
				{ k: "query-call", fn: "match-all", args: [] },
				out,
			);
			return;
		default: {
			const exhaustive: never = node;
			throw new Error(`Unknown CSQL node ${String(exhaustive)}.`);
		}
	}
}

/** An obligation on an empty concat argument, so it changes no CSQL byte. */
function carrier(obligation: CsqlObligation): CsqlSegment {
	return {
		kind: "runtime",
		xpath: w.str(""),
		rejectWhen: obligation.condition,
		rejectionKind: obligation.kind,
		...(obligation.inputNames === undefined
			? {}
			: { rejectionInputNames: obligation.inputNames }),
	};
}

function obligationFields(obligation: CsqlObligation | undefined) {
	return obligation === undefined
		? {}
		: {
				rejectWhen: obligation.condition,
				rejectionKind: obligation.kind,
				...(obligation.inputNames === undefined
					? {}
					: { rejectionInputNames: obligation.inputNames }),
			};
}

function hole(runtime: CsqlRuntimeHole, out: CsqlSegment[]): void {
	const value = runtime.value;
	switch (runtime.quoting) {
		case "quoted": {
			// The device picks the delimiter after the value resolves: double
			// quotes (HQ's documented runtime form) unless the value holds one,
			// then single; a value holding both cannot be a CSQL literal. This is
			// not sanitising: changing a quote would change what the search
			// matches.
			const containsSingle = w.call("contains", [value, w.str("'")]);
			const containsDouble = w.call("contains", [value, w.str('"')]);
			out.push({
				kind: "runtime",
				xpath: w.call("if", [
					containsDouble,
					w.call("concat", [w.str("'"), value, w.str("'")]),
					w.call("concat", [w.str('"'), value, w.str('"')]),
				]),
				value,
				key: runtime.key,
				stringValueXPath: value,
				rejectWhen: w.and(containsSingle, containsDouble),
				rejectionInputNames: runtime.inputNames,
			});
			if (runtime.obligation !== undefined)
				out.push(carrier(runtime.obligation));
			return;
		}
		case "quote-free":
			text(out, '"');
			out.push({
				kind: "runtime",
				xpath: runtime.print ?? value,
				value,
				key: runtime.key,
				...obligationFields(runtime.obligation),
			});
			text(out, '"');
			return;
		case "bare":
			out.push({
				kind: "runtime",
				xpath: runtime.print ?? value,
				value,
				key: runtime.key,
				...obligationFields(runtime.obligation),
			});
			return;
	}
}

/**
 * A choice the device makes between two clauses: one runtime segment
 * `if(<condition>, <then>, <else>)`. Each branch's obligations travel out
 * guarded by the condition that picks it, so the outermost wrapper still fails
 * the whole row closed and an obligation of the branch not taken rejects
 * nothing. Consuming them inside the branch would leave `match-none()` as an
 * operand of a `not` or an `or`, where it broadens the search.
 */
function choice(
	key: string,
	condition: WireExpr,
	thenNode: CsqlNode,
	elseNode: CsqlNode,
	out: CsqlSegment[],
): void {
	const thenPart = concatParts(printCsql(thenNode));
	const elsePart = concatParts(printCsql(elseNode));
	const xpath = w.call("if", [condition, thenPart.query, elsePart.query]);
	const rejections = [
		...thenPart.runtimeRejections.map((rejection) => ({
			...rejection,
			condition: w.and(condition, rejection.condition),
		})),
		...elsePart.runtimeRejections.map((rejection) => ({
			...rejection,
			condition: w.and(w.not(condition), rejection.condition),
		})),
	];
	if (rejections.length === 0) {
		out.push({ kind: "runtime", xpath, key });
		return;
	}
	rejections.forEach((rejection, index) => {
		out.push({
			kind: "runtime",
			// One segment carries the query; the others carry their obligation
			// on an empty argument, each kept separately classifiable.
			xpath: index === 0 ? xpath : w.str(""),
			...(index === 0 ? { key } : {}),
			rejectWhen: rejection.condition,
			rejectionKind: rejection.kind,
			rejectionInputNames: rejection.inputNames,
		});
	});
}

function mergeAdjacentConstants(
	segments: readonly CsqlSegment[],
): CsqlSegment[] {
	const merged: CsqlSegment[] = [];
	for (const segment of segments) {
		const last = merged[merged.length - 1];
		if (segment.kind === "constant" && last?.kind === "constant") {
			merged[merged.length - 1] = {
				kind: "constant",
				text: last.text + segment.text,
			};
			continue;
		}
		merged.push(segment);
	}
	return merged;
}

function constantText(segments: readonly CsqlSegment[]): string {
	return segments
		.map((segment) => (segment.kind === "constant" ? segment.text : ""))
		.join("");
}

function wrapSegments(merged: readonly CsqlSegment[]): CsqlEmissionResult {
	if (merged.every((segment) => segment.kind === "constant"))
		return { wrapper: w.str(constantText(merged)) };
	const cascade = quoteCascade(merged);
	if (cascade !== undefined) return cascade;
	const { query, runtimeRejections } = concatParts(merged);
	if (runtimeRejections.length === 0) return { wrapper: query };
	return {
		wrapper: w.call("if", [
			w.or(...runtimeRejections.map(({ condition }) => condition)),
			w.str("match-none()"),
			query,
		]),
		runtimeRejections,
	};
}

/**
 * A clause whose one runtime value is one quoted string, as the flat quote
 * cascade:
 *
 *   `if(contains(v, '"'),
 *       if(contains(v, "'"), 'match-none()', concat("…'", v, "'…")),
 *       concat('…"', v, '"…'))`
 *
 * The CSQL bytes for a valid value are the general shape's; only the on-device
 * expression is flatter. Any other runtime segment or typed obligation takes
 * the general shape, where each obligation composes on its own.
 */
function quoteCascade(
	merged: readonly CsqlSegment[],
): CsqlEmissionResult | undefined {
	const runtimeIndex = merged.findIndex(
		(segment) => segment.kind === "runtime",
	);
	if (runtimeIndex === -1) return undefined;
	if (
		merged.some(
			(segment, index) => index !== runtimeIndex && segment.kind === "runtime",
		)
	)
		return undefined;
	const segment = merged[runtimeIndex];
	if (
		segment.kind !== "runtime" ||
		segment.stringValueXPath === undefined ||
		segment.rejectWhen === undefined ||
		(segment.rejectionKind ?? "quote") !== "quote"
	)
		return undefined;
	const value = segment.stringValueXPath;
	const prefix = constantText(merged.slice(0, runtimeIndex));
	const suffix = constantText(merged.slice(runtimeIndex + 1));
	const wrapper = w.call("if", [
		w.call("contains", [value, w.str('"')]),
		w.call("if", [
			w.call("contains", [value, w.str("'")]),
			w.str("match-none()"),
			stringExpression([w.str(`${prefix}'`), value, w.str(`'${suffix}`)]),
		]),
		stringExpression([w.str(`${prefix}"`), value, w.str(`"${suffix}`)]),
	]);
	return {
		wrapper,
		runtimeRejections: [
			{
				condition: segment.rejectWhen,
				kind: "quote",
				...(segment.rejectionInputNames === undefined
					? {}
					: { inputNames: [...segment.rejectionInputNames].sort() }),
			},
		],
	};
}

/** One or more values as the shortest expression of their concatenation. */
function stringExpression(args: readonly WireExpr[]): WireExpr {
	if (args.length === 0) return w.str("");
	if (args.length === 1) return args[0];
	return w.call("concat", args);
}

/** The concat of a segment list, its obligations still travelling outward. */
function concatParts(segments: readonly CsqlSegment[]): {
	readonly query: WireExpr;
	readonly runtimeRejections: readonly RuntimeCsqlRejection[];
} {
	const merged = mergeAdjacentConstants(segments);
	const args: WireExpr[] = [];
	const rejections: RuntimeCsqlRejection[] = [];
	for (const segment of merged) {
		if (segment.kind === "constant") {
			args.push(w.str(segment.text));
			continue;
		}
		args.push(segment.xpath);
		if (segment.rejectWhen !== undefined)
			rejections.push({
				condition: segment.rejectWhen,
				kind: segment.rejectionKind ?? "quote",
				...(segment.rejectionInputNames === undefined
					? {}
					: { inputNames: [...segment.rejectionInputNames].sort() }),
			});
	}
	return {
		query: stringExpression(args),
		runtimeRejections: dedupeRuntimeRejections(rejections),
	};
}
