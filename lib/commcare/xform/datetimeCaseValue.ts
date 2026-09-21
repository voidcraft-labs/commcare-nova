import { RESERVED_XFORM_NODE_PREFIX } from "../constants";
import type { FormPath } from "./formPath";

/** HQ generates untyped case-update binds. Reading a date-valued question into
 * one wraps it as DateData and loses the clock. A sibling text value preserves
 * the full instant on both HQ-regenerated and directly emitted submissions. */
export function datetimeCaseValueName(fieldId: string): string {
	return `${RESERVED_XFORM_NODE_PREFIX}datetime_${fieldId}`;
}

export function datetimeCaseValuePath(path: FormPath): FormPath {
	const last = path.segments().at(-1);
	if (last?.kind !== "element")
		throw new Error("A datetime answer must have an element path.");
	return path.parent().child(datetimeCaseValueName(last.name));
}

export function datetimeCaseValueCalculate(path: FormPath): string {
	// Core format-date(node-set) passes through toDate(), which rounds a
	// typed Date to midnight. coalesce unpacks the selected value first.
	const source = path.toXPath();
	return `if(${source} = '', '', format-date(coalesce(${source}, ''), '%Y-%m-%dT%H:%M:%S.%3%Z'))`;
}
