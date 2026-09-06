/** Shared constructors for raw XML values. Emitters build ordered domhandler
 * trees; serializeXml is the sole escaping and whitespace-preservation boundary.
 * Never escape a value before constructing its element or text node. */

import { type ChildNode, Element, Text } from "domhandler";

/**
 * Build an XML element with raw attribute values and optional element
 * children. Attribute insertion order is preserved by the serializer, so
 * callers control byte-level attribute sequence by ordering the `attribs`
 * object literal.
 */
export function el(
	name: string,
	attribs: Record<string, string>,
	children: ChildNode[] = [],
): Element {
	return new Element(name, attribs, children);
}

/**
 * Build a Text node carrying raw character data. The serializer XML-escapes
 * the text exactly once at render time.
 */
export function text(data: string): Text {
	return new Text(data);
}
