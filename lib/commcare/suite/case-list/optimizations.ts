/**
 * Faster loading on the local suite, as HQ's build writes it: each eligible
 * field carries `lazy_loading` and `cache_enabled` for its column's load
 * behavior (`detail_screen.py::FormattedDetailColumn._set_case_list_optimizations`),
 * and the detail carries each one any of its columns does
 * (`suite_xml/sections/details.py::_add_detail_optimizations`). Core reads
 * both (`DetailParser`, `DetailFieldParser`).
 */

import type { Element } from "domhandler";
import {
	type CaseListConfig,
	type Column,
	type ColumnLoadBehavior,
	columnSupportsLoadBehavior,
} from "@/lib/domain";

/** The load behavior HQ's build writes for `column`, if any. */
export function columnLoadBehavior(
	config: Pick<CaseListConfig, "optimizations"> | undefined,
	column: Column,
): ColumnLoadBehavior | undefined {
	if (config?.optimizations !== true || !columnSupportsLoadBehavior(column))
		return undefined;
	return "loadBehavior" in column ? column.loadBehavior : undefined;
}

/** Writes `behavior`'s two attributes on a field or detail element. */
function writeBehavior(element: Element, behavior: ColumnLoadBehavior): void {
	if (behavior !== "cache") element.attribs.lazy_loading = "true";
	if (behavior !== "defer") element.attribs.cache_enabled = "true";
}

/** `field` with its column's load behavior. */
export function withFieldLoadBehavior(
	field: Element,
	behavior: ColumnLoadBehavior | undefined,
): Element {
	if (behavior !== undefined) writeBehavior(field, behavior);
	return field;
}

/** `detail` with every load behavior one of its shown columns holds. */
export function withDetailLoadBehavior(
	detail: Element,
	config: CaseListConfig | undefined,
	shown: readonly Column[],
): Element {
	for (const column of shown) {
		const behavior = columnLoadBehavior(config, column);
		if (behavior !== undefined) writeBehavior(detail, behavior);
	}
	return detail;
}
