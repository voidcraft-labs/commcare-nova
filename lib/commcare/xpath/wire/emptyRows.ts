/** A value read of an instance Core builds from its rows alone, guarded so
 * that no rows reads blank (`lib/commcare/xpath/wire/CLAUDE.md`, "Reads of
 * rows that may be empty"). `fromExpression.ts` applies it by consumer, and
 * generated scaffolding that reads such an instance as a value applies
 * `guardValue` itself.
 *
 * The blank a guard reads is the blank Core reads for an empty node-set
 * wherever it unpacks one: `XPathNodeset.unpack` returns
 * `XPathPathExpr.unpackValue(null)`, which is `''`, for a valid set with no
 * nodes, so `<empty set> = ''` holds in Core exactly as the guard's
 * `'' = ''` does. */
import { FUNCTION_REGISTRY } from "@/lib/domain/expressionFunctions";
import { w } from "./builders";
import type { WireExpr, WirePath } from "./tree";

/** The row list `count` reads to guard `read`, when `read` is an absolute
 * read through the rows of an instance Core builds from its data alone
 * (`InstanceDecl.rows`): its first step the root element and its second the
 * row element, so the guard counts exactly the rows the read goes through.
 * A read Core should refuse there (`WirePath.refusesEmpty`) is left alone.
 * Core checks a path's steps with predicates ignored, so when any row exists
 * every read Core accepts today answers as before. */
export function emptiableRows(read: WireExpr): WirePath | undefined {
	const path = read.k === "expansion" ? read.expr : read;
	if (
		path.k !== "path" ||
		path.root.k !== "instance" ||
		path.refusesEmpty === true
	)
		return undefined;
	const rows = path.root.decl.rows;
	if (rows === undefined) return undefined;
	const [rootStep, rowStep] = path.steps;
	if (
		rootStep?.axis !== "child" ||
		rootStep.name !== rows.root ||
		rowStep?.axis !== "child" ||
		rowStep.name !== rows.row
	)
		return undefined;
	return w.instance(path.root.decl, [w.step(rows.root), w.step(rows.row)]);
}

/** `if(count(<rows>) > 0, <read>, <empty>)`: a read of an instance with no
 * rows reads `empty` (what Core reads for an empty set there) instead of
 * Core's refusal, and reads exactly as written otherwise, since `if` returns
 * its branch unconverted. */
export function guardRead(
	read: WireExpr,
	rows: WirePath,
	empty: WireExpr,
): WireExpr {
	return w.call("if", [w.gt(w.call("count", [rows]), w.num(0)), read, empty]);
}

/** The read guarded with `''`, or unchanged when it reads no data-built
 * instance. */
export function guardValue(read: WireExpr): WireExpr {
	const rows = emptiableRows(read);
	return rows === undefined ? read : guardRead(read, rows, w.str(""));
}

/** `consume(nodes)` for a consumer Core refuses unless it reads a node-set
 * (`sum`, `XPathSumFunc.evalBody`), reading `empty` wherever the node-set it
 * is handed comes from an instance with no rows. Core hands a node-set
 * through a pass-through call unconverted, so the guard follows it there:
 * over the branches of a lazy call (`if`, `cond`) the consumer moves into
 * each branch, which then guards only the rows it reads, so a branch over
 * rows that exist answers as written; through an eager one that always
 * returns the set (`depend`'s first, `sleep`'s second, a lone `coalesce`
 * value) it consumes the rebuilt call. A `coalesce` with earlier values
 * returns the first that is not blank instead of the set
 * (`XpathCoalesceFunc.evalBody`), which such a consumer refuses whether or
 * not any row exists, so it stays bare: Core gives no `empty` for it. */
export function guardNodeSetConsumer(
	nodes: WireExpr,
	consume: (nodes: WireExpr) => WireExpr,
	empty: WireExpr,
): WireExpr {
	if (nodes.k === "call") {
		const spec = FUNCTION_REGISTRY.get(nodes.fn);
		const through = spec?.passThrough?.(nodes.args.length);
		if (through !== undefined && through.size > 0) {
			if (spec?.evaluation === "lazy")
				return w.call(
					nodes.fn,
					nodes.args.map((arg, index) =>
						through.has(index)
							? guardNodeSetConsumer(arg, consume, empty)
							: arg,
					),
				);
			const [index] = [...through];
			const passed = index === undefined ? undefined : nodes.args[index];
			if (nodes.fn === "coalesce" && nodes.args.length > 1)
				return consume(nodes);
			if (passed !== undefined && through.size === 1)
				return guardNodeSetConsumer(
					passed,
					(inner) =>
						consume(
							w.call(
								nodes.fn,
								nodes.args.map((arg, at) => (at === index ? inner : arg)),
							),
						),
					empty,
				);
		}
	}
	const rows = emptiableRows(nodes);
	return rows === undefined
		? consume(nodes)
		: guardRead(consume(nodes), rows, empty);
}

/** `consume(sets)` for a consumer Core reads as node-sets only when every one
 * of `sets` is, and otherwise reads value by value (`weighted-checklist`'s
 * pair, `XPathWeightedChecklistFunc.evalBody`). Guarding each set alone
 * would hand Core a value beside a set, so the sets are guarded together:
 * the call reads `empty`, the answer for no values at all, exactly when every
 * set is empty, an instance with no rows counting as empty, and reads as
 * written otherwise. A set over an instance with no rows is never read then,
 * since Core's `or` stops at its first true operand
 * (`XPathBoolExpr.evalRaw`). Sets that are not all paths stay bare. */
export function guardJointNodeSets(
	sets: readonly WireExpr[],
	consume: (sets: readonly WireExpr[]) => WireExpr,
	empty: WireExpr,
): WireExpr {
	const paths = sets.every(
		(set) =>
			set.k === "path" || (set.k === "expansion" && set.expr.k === "path"),
	);
	const rows = sets.map(emptiableRows);
	if (!paths || rows.every((list) => list === undefined)) return consume(sets);
	const none = (nodes: WireExpr) => w.eq(w.call("count", [nodes]), w.num(0));
	return w.call("if", [
		w.and(
			...sets.map((set, index) => {
				const list = rows[index];
				return list === undefined ? none(set) : w.or(none(list), none(set));
			}),
		),
		empty,
		consume(sets),
	]);
}
