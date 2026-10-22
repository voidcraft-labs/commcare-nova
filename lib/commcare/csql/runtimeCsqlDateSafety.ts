/**
 * The blank-comparand obligation: a runtime value CommCare's search cannot
 * compare while it is blank.
 *
 * HQ's search raises on `''` in two places. `date_opened`, `closed_on` and
 * `last_modified` go to its system datetime query whatever the operator, and
 * `''` is not a date (`corehq/apps/case_search/xpath_functions/comparison.py::property_comparison_query`,
 * `_create_system_datetime_query`). Every other ordering goes to its range
 * query, which tries a number and then a date or a date and time and raises
 * on `''` (`comparison.py::_case_property_range_query`). No Expression can
 * spell "this runtime value is not blank" in a CSQL slot, so the emitter
 * guards it: the obligation rides an empty carrier segment, and the clause
 * wrapper answers `'match-none()'` while any guarded value is blank. The
 * obligation names no prompt and carries no message for a worker; a blank
 * value simply finds nothing.
 */

import type { ComparisonKind, Expression } from "@/lib/domain/expression/types";
import { SYSTEM_DATETIME_CASE_PROPERTIES } from "@/lib/domain/standardCaseProperties";
import { w } from "../xpath/wire/builders";
import { serializeWire } from "../xpath/wire/serialize";
import type { WireExpr } from "../xpath/wire/tree";
import type { CsqlNode, CsqlObligation } from "./tree";

/**
 * Whether a comparison of `anchor` with a runtime value can reach HQ with a
 * blank comparand it refuses: any operator on a system date, or an ordering
 * on any property.
 */
export function needsBlankComparandGuard(
	anchor: Expression,
	kind: ComparisonKind,
): boolean {
	if (anchor.kind !== "term" || anchor.term.kind !== "prop") return false;
	if (SYSTEM_DATETIME_CASE_PROPERTIES.has(anchor.term.property)) return true;
	return kind !== "eq" && kind !== "neq";
}

/**
 * The on-device reads a value splices in: each runtime hole's raw read, unless
 * a typed obligation already proves the value is well formed (a geopoint, a
 * number), which no blank passes.
 */
function runtimeReads(node: CsqlNode, out: WireExpr[]): void {
	switch (node.k) {
		case "runtime":
			if (node.hole.neverBlank === true) return;
			if (node.hole.quoting === "quoted") out.push(node.hole.value);
			else if (node.hole.obligation === undefined)
				out.push(node.hole.print ?? node.hole.value);
			return;
		case "json-list":
			for (const item of node.items)
				if (item.k === "runtime" && item.hole.obligation === undefined)
					out.push(item.hole.value);
			return;
		case "cmp":
			runtimeReads(node.left, out);
			runtimeReads(node.right, out);
			return;
		case "and":
		case "or":
			for (const item of node.items) runtimeReads(item, out);
			return;
		case "not":
		case "group":
		case "guarded":
			runtimeReads(node.item, out);
			return;
		case "query-call":
		case "value-call":
			for (const arg of node.args) runtimeReads(arg, out);
			return;
		case "step":
		case "literal":
		case "number":
		case "choice":
		case "presence":
			return;
	}
}

/**
 * The obligation that guards the runtime values among `values`, or nothing
 * where they splice no runtime value. It rides an empty carrier, so the CSQL
 * bytes of a value that is not blank do not change.
 */
export function blankComparandGuard(
	values: readonly CsqlNode[],
): CsqlObligation | undefined {
	const reads: WireExpr[] = [];
	for (const value of values) runtimeReads(value, reads);
	const byText = new Map<string, WireExpr>();
	for (const read of reads)
		byText.set(serializeWire(read, { target: "suite" }).text, read);
	const distinct = [...byText.values()];
	if (distinct.length === 0) return undefined;
	return {
		condition: w.or(...distinct.map((read) => w.eq(read, w.str("")))),
		kind: "blank-comparand",
	};
}
