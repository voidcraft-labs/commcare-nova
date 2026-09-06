/**
 * Remove editor-only attributes before shipping an XForm to CommCare Core.
 * HQ performs the same step in FormBase.add_stuff_to_xform. Core's bind and
 * action parsers look up several attributes with a null namespace, so an
 * earlier Vellum shadow can be read as executable XPath and fail to parse.
 */
import { type ChildNode, isTag } from "domhandler";
import { parseXForm, serializeXForm } from "./domSplice";

const VELLUM_NAMESPACE = "http://commcarehq.org/xforms/vellum";

export function stripVellumAttributes(xform: string): string {
	const doc = parseXForm(xform);
	const walk = (
		nodes: ChildNode[],
		inherited: ReadonlyMap<string, string>,
	): void => {
		for (const node of nodes) {
			if (!isTag(node)) continue;
			const declarations = Object.entries(node.attribs).filter(([name]) =>
				name.startsWith("xmlns:"),
			);
			const namespaces = declarations.length
				? new Map([
						...inherited,
						...declarations.map(([name, uri]) => [name.slice(6), uri] as const),
					])
				: inherited;
			for (const name of Object.keys(node.attribs)) {
				const colon = name.indexOf(":");
				if (
					colon > 0 &&
					namespaces.get(name.slice(0, colon)) === VELLUM_NAMESPACE
				)
					delete node.attribs[name];
			}
			walk(node.children, namespaces);
		}
	};
	walk(doc.children, new Map());
	return serializeXForm(doc);
}
