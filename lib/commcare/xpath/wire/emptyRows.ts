/** A value read of an instance Core builds from its rows alone, guarded so
 * that no rows reads blank (`lib/commcare/xpath/wire/CLAUDE.md`, "Reads of
 * rows that may be empty"). `fromExpression.ts` applies it by consumer, and
 * generated scaffolding that reads such an instance as a value applies
 * `guardValue` itself. */
import { w } from "./builders";
import type { WireExpr, WirePath } from "./tree";

/** Whether Core builds this instance's root from its data alone, with no
 * template, so a path whose step reaches no node is an invalid node-set
 * (`XPathPathExpr.evalRaw` → `DataInstance.hasTemplatePath`). Core picks
 * the root by `src` (`CommCareInstanceInitializer.generateRoot`): a fixture
 * (a lookup table, the flat place list), the selected entities and the
 * search answers. `casedb` and `results:inline` read the case template. */
function dataBuiltInstance(src: string): boolean {
	return (
		src.startsWith("jr://fixture/") ||
		src.startsWith("jr://instance/selected-entities/") ||
		src.startsWith("jr://instance/search-input/")
	);
}

/** The row list `count` reads to guard `read`, when `read` is an absolute
 * read of a data-built instance: its root element and row element, with no
 * predicates. Core checks a path's steps with predicates ignored, so when
 * any row exists every read Core accepts today answers as before. */
export function emptiableRows(read: WireExpr): WirePath | undefined {
	const path = read.k === "expansion" ? read.expr : read;
	if (path.k !== "path" || path.root.k !== "instance") return undefined;
	if (!dataBuiltInstance(path.root.decl.src)) return undefined;
	const [rootStep, rowStep] = path.steps;
	if (rootStep === undefined || rowStep === undefined) return undefined;
	return w.instance(path.root.decl, [
		{ ...rootStep, predicates: [] },
		{ ...rowStep, predicates: [] },
	]);
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
