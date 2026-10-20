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
 * rows that exist answers as written; through an eager one (`depend`'s
 * first, `sleep`'s second, `coalesce`'s last) it consumes the rebuilt call.
 * A `coalesce` hands on its set only when every earlier value is blank
 * (`XpathCoalesceFunc.evalBody`: the first that is neither `''` nor NaN is
 * returned in its place, which such a consumer refuses with or without
 * rows), so the guard reads `empty` only when the rows are missing AND those
 * values are blank, and the call as written otherwise. */
export function guardNodeSetConsumer(
	nodes: WireExpr,
	consume: (nodes: WireExpr) => WireExpr,
	empty: WireExpr,
	/** Holds when every value an enclosing `coalesce` reads before the set is
	 * blank, so that `coalesce` hands the set on. */
	handedOn?: WireExpr,
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
							? guardNodeSetConsumer(arg, consume, empty, handedOn)
							: arg,
					),
				);
			const [index] = [...through];
			const passed = index === undefined ? undefined : nodes.args[index];
			if (passed !== undefined && through.size === 1) {
				const earlier =
					nodes.fn === "coalesce" ? nodes.args.slice(0, index) : [];
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
					earlier.length === 0
						? handedOn
						: w.and(
								...(handedOn === undefined ? [] : [handedOn]),
								allBlank(earlier),
							),
				);
			}
		}
	}
	const rows = emptiableRows(nodes);
	if (rows === undefined) return consume(nodes);
	if (handedOn === undefined) return guardRead(consume(nodes), rows, empty);
	return w.call("if", [
		w.and(w.eq(w.call("count", [rows]), w.num(0)), handedOn),
		empty,
		consume(nodes),
	]);
}

/** `string(coalesce(<values>, '')) = ''`: whether every one of `values` is
 * blank as `coalesce` tests it (`''` or NaN). `coalesce` returns the first
 * that is not, unpacked, and `string` keeps a `false()` or a date from
 * comparing equal to `''`. */
function allBlank(values: readonly WireExpr[]): WireExpr {
	return w.eq(
		w.call("string", [w.call("coalesce", [...values, w.str("")])]),
		w.str(""),
	);
}

/** Whether Core can ever read `expr` as a node-set: a path, or a call that
 * returns one of its arguments as it evaluates. Literals, operators and every
 * other function return a value. */
function mayBeNodeSet(expr: WireExpr): boolean {
	if (expr.k === "path" || expr.k === "expansion") return true;
	if (expr.k !== "call") return false;
	return (
		(FUNCTION_REGISTRY.get(expr.fn)?.passThrough?.(expr.args.length).size ??
			0) > 0
	);
}

/** `consume(sets)` for `weighted-checklist`'s four-argument pair, which Core
 * reads as two node-sets only when both are, and otherwise value by value
 * (`XPathWeightedChecklistFunc.evalBody`). A lazy call (`if`, `cond`) in the
 * pair hands Core the branch it takes, so the call moves into its branches
 * and each is guarded on its own. Then:
 *
 * - Two paths are guarded together: the call reads `empty`, the answer for
 *   no values at all, exactly when every set is empty, an instance with no
 *   rows counting as empty, and reads as written otherwise. Guarding each set
 *   alone would hand Core a value beside a set. A set over an instance with
 *   no rows is never read then, since Core's `or` stops at its first true
 *   operand (`XPathBoolExpr.evalRaw`).
 * - A path beside a value Core can never read as a node-set is read value by
 *   value, so the path takes the `''` guard, which is what Core unpacks from
 *   a valid empty set there (`XPathNodeset.unpack`).
 * - Anything else (a path beside an eager pass-through call, which may or may
 *   not hand Core a set) stays bare. */
export function guardChecklistPair(
	sets: readonly WireExpr[],
	consume: (sets: readonly WireExpr[]) => WireExpr,
	empty: WireExpr,
): WireExpr {
	const lazy = sets.findIndex(
		(set) =>
			set.k === "call" &&
			FUNCTION_REGISTRY.get(set.fn)?.evaluation === "lazy" &&
			(FUNCTION_REGISTRY.get(set.fn)?.passThrough?.(set.args.length).size ??
				0) > 0,
	);
	const branching = sets[lazy];
	if (branching?.k === "call") {
		const through = FUNCTION_REGISTRY.get(branching.fn)?.passThrough?.(
			branching.args.length,
		);
		return w.call(
			branching.fn,
			branching.args.map((arg, index) =>
				through?.has(index) === true
					? guardChecklistPair(
							sets.map((set, at) => (at === lazy ? arg : set)),
							consume,
							empty,
						)
					: arg,
			),
		);
	}
	const paths = sets.map(
		(set) =>
			set.k === "path" || (set.k === "expansion" && set.expr.k === "path"),
	);
	if (paths.every(Boolean)) {
		const rows = sets.map(emptiableRows);
		if (rows.every((list) => list === undefined)) return consume(sets);
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
	if (sets.some((set, index) => !paths[index] && mayBeNodeSet(set)))
		return consume(sets);
	return consume(sets.map(guardValue));
}
