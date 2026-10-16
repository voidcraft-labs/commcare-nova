/**
 * The blank-comparand obligation: a runtime value CommCare's search cannot
 * compare while it is blank.
 *
 * HQ's search raises on `''` in two places. `date_opened`, `closed_on` and
 * `last_modified` go to its system datetime query whatever the operator, and
 * `''` is not a date (`corehq/apps/case_search/xpath_functions/comparison.py::property_comparison_query`,
 * `_create_system_datetime_query`). Every other ordering goes to its range
 * query, which tries a number and then a date or a date and time and raises
 * on `''` (`comparison.py::_case_property_range_query`). No Predicate can
 * spell "this runtime value is not blank" in a CSQL slot, so the emitter
 * guards it: the obligation rides an empty carrier segment, and the clause
 * wrapper answers `'match-none()'` while any guarded value is blank. The
 * obligation names no prompt and carries no message for a worker; a blank
 * value simply finds nothing.
 */

import type { ComparisonKind, ValueExpression } from "@/lib/domain/predicate";
import { SYSTEM_DATETIME_CASE_PROPERTIES } from "@/lib/domain/standardCaseProperties";
import type { CsqlSegment } from "./csqlSegment";

/**
 * Whether a comparison of `anchor` with a runtime value can reach HQ with a
 * blank comparand it refuses: any operator on a system date, or an ordering
 * on any property.
 */
export function needsBlankComparandGuard(
	anchor: ValueExpression,
	kind: ComparisonKind,
): boolean {
	if (anchor.kind !== "term" || anchor.term.kind !== "prop") return false;
	if (SYSTEM_DATETIME_CASE_PROPERTIES.has(anchor.term.property)) return true;
	return kind !== "eq" && kind !== "neq";
}

/**
 * The on-device value XPath of every runtime interpolation in one value's
 * segments: the raw read a quoted segment carries, or the read a quote-free
 * segment interpolates as it is. A segment that only carries another
 * obligation interpolates nothing and is skipped.
 */
function runtimeValueXPaths(segments: readonly CsqlSegment[]): string[] {
	const values: string[] = [];
	for (const segment of segments) {
		if (segment.kind !== "runtime") continue;
		if (segment.stringValueXPath !== undefined) {
			values.push(segment.stringValueXPath);
		} else if (segment.rejectWhen === undefined) {
			values.push(segment.xpath);
		}
	}
	return values;
}

/**
 * The carrier segment that guards the runtime values among `values`, or
 * nothing where they interpolate no runtime value. Its `xpath` is `''`, so
 * the CSQL bytes of a value that is not blank do not change.
 */
export function blankComparandGuard(
	values: readonly (readonly CsqlSegment[])[],
): CsqlSegment[] {
	const reads = [...new Set(values.flatMap(runtimeValueXPaths))];
	if (reads.length === 0) return [];
	return [
		{
			kind: "runtime",
			xpath: "''",
			rejectWhen: reads.map((read) => `${read} = ''`).join(" or "),
			rejectionKind: "blank-comparand",
		},
	];
}
