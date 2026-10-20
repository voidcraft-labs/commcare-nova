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
import { SELECTED_ENTITY_ROWS, selectedCasesInstance } from "./instances";
import type { WireExpr, WirePath } from "./tree";

/** The row list `count` reads to guard `read`, when `read` is an absolute
 * read through the rows of an instance Core builds from its data alone
 * (`InstanceDecl.rows`), unless the read is one Core should refuse there
 * (`WirePath.refusesEmpty`). Core checks a path's steps with predicates ignored,
 * so when any row exists every read Core accepts today answers as before. */
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
		rowStep === undefined
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
 * rows that exist answers as written; through an eager one (`coalesce`'s
 * last value, `depend`'s first, `sleep`'s second) it consumes the rebuilt
 * call. `coalesce` returns a value instead of the set when an earlier value
 * is not blank, which such a consumer refuses too, so reading `empty` when
 * the set's rows are empty changes no answer Core gives. */
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

/** The chosen case ids of a several-case datum as one space-separated value:
 * `join(' ', <ids>)` with the ids guarded, which reads blank when none is
 * chosen. No case is chosen only through a session endpoint: Web Apps' own
 * list sets the datum for one or more
 * (`MultiSelectEntityScreen.validateSelectionSize` refuses 0), but
 * Formplayer builds an endpoint's selection from the link's argument with
 * `split(",")`
 * (`MenuSessionRunnerService.processEndpointArgumentsForVirualInstance`),
 * which reads `","` as no ids, and the replay accepts that
 * (`prcessSelectionAsGuid` → `validateEntitiesInInstance` loops over none),
 * while Core refuses a `join` of the empty instance. */
export function joinedSelectedCaseIds(datumId: string): WireExpr {
	return w.call("join", [
		w.str(" "),
		guardValue(
			w.instance(selectedCasesInstance(datumId), [
				w.step(SELECTED_ENTITY_ROWS.root),
				w.step(SELECTED_ENTITY_ROWS.row),
			]),
		),
	]);
}
