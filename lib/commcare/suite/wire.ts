import type { ColumnVia } from "@/lib/domain/modules";
import { RESERVED_CASE_ATTRIBUTES } from "../casePropertyWire";
import { w } from "../xpath/wire/builders";
import { buildAncestorJoinNodeset } from "../xpath/wire/rowScope";
import type { WireExpr, WirePath } from "../xpath/wire/tree";

/** A case-row property, with standard metadata kept on its attribute axis. */
export function casePropertyPath(property: string): WirePath {
	return w.context([
		RESERVED_CASE_ATTRIBUTES.has(property)
			? w.attr(property)
			: w.step(property),
	]);
}

/**
 * A property column's value on a case row: the row's own property, or the
 * property of the case the column's walk reaches, read as CommCare HQ's build
 * reads a `field` of indices and a property
 * (`detail_screen.py::PropertyXpathGenerator.xpath`): each index joined by
 * case id over `casedb` from `current()`, with no case-type test, since HQ's
 * field carries no type, then the property.
 */
export function columnPropertyPath(column: {
	readonly field: string;
	readonly via?: ColumnVia;
}): WirePath {
	if (column.via === undefined) return casePropertyPath(column.field);
	return w.append(
		buildAncestorJoinNodeset(
			column.via.map((step) => ({ identifier: step.identifier })),
			"casedb",
		),
		casePropertyPath(column.field).steps,
	);
}

/** The existing JavaRosa lowering of XPath's four-character whitespace set. */
export function normalizeSpace(value: WireExpr): WireExpr {
	return w.call("replace", [
		w.call("replace", [value, w.str("[ \\t\\r\\n]+"), w.str(" ")]),
		w.str("^ | $"),
		w.str(""),
	]);
}
