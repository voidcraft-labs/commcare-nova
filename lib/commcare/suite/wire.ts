import { RESERVED_CASE_ATTRIBUTES } from "../casePropertyWire";
import { w } from "../xpath/wire/builders";
import type { WireExpr, WirePath } from "../xpath/wire/tree";

/** A case-row property, with standard metadata kept on its attribute axis. */
export function casePropertyPath(property: string): WirePath {
	return w.context([
		RESERVED_CASE_ATTRIBUTES.has(property)
			? w.attr(property)
			: w.step(property),
	]);
}

/** The existing JavaRosa lowering of XPath's four-character whitespace set. */
export function normalizeSpace(value: WireExpr): WireExpr {
	return w.call("replace", [
		w.call("replace", [value, w.str("[ \\t\\r\\n]+"), w.str(" ")]),
		w.str("^ | $"),
		w.str(""),
	]);
}
