import {
	printXPath,
	type XPathExpression,
	type XPathPrintableDoc,
	xpathPrintContext,
} from "@/lib/domain";

/** Route both authored reference spellings through the form's wire-path map.
 * The stored UUID stays unchanged; wrapper and iteration names belong only to
 * emission. Using one spelling here also keeps Vellum shadows consistent. */
export function printWireXPathSource(
	expression: XPathExpression,
	doc: XPathPrintableDoc,
): string {
	return printXPath(
		{
			...expression,
			parts: expression.parts.map((part) =>
				part.kind === "path-ref"
					? { kind: "field-ref", uuid: part.uuid }
					: part,
			),
		},
		xpathPrintContext(doc),
	);
}
