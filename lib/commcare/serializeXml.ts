import { type AnyNode, isTag } from "domhandler";
import { encodeXML } from "entities";
import { xmlTextIssue } from "./xmlText";

/** The one encoder for raw XML values. XML normalizes literal CR in text and
 * all literal whitespace in attributes, so those characters require numeric
 * references even though they are legal XML characters. */
function value(text: string, attribute: boolean): string {
	const issue = xmlTextIssue(text);
	if (issue !== undefined) throw new Error(`XML text contains ${issue}.`);
	const encoded = encodeXML(text);
	return attribute
		? encoded
				.replaceAll("\t", "&#x9;")
				.replaceAll("\n", "&#xa;")
				.replaceAll("\r", "&#xd;")
		: encoded.replaceAll("\r", "&#xd;");
}

/**
 * Serialize Nova's XML trees without changing character data. Emitters pass
 * raw values and never escape them. HTML serialization is unsuitable here:
 * dom-serializer's XML mode still loses whitespace through native XML parsing.
 * This writer preserves ordered children/attributes and does not mutate nodes.
 */
export function serializeXml(node: AnyNode): string {
	if (isTag(node)) {
		const attributes = Object.entries(node.attribs)
			.map(([name, text]) => ` ${name}="${value(text, true)}"`)
			.join("");
		return node.children.length === 0
			? `<${node.name}${attributes}/>`
			: `<${node.name}${attributes}>${node.children.map(serializeXml).join("")}</${node.name}>`;
	}
	switch (node.type) {
		case "root":
			return node.children.map(serializeXml).join("");
		case "text":
			return value(node.data, false);
		case "cdata":
			// Ordinary escaped text carries the identical value without CDATA's
			// line-ending normalization or its special closing delimiter.
			return node.children.map(serializeXml).join("");
		case "comment":
			if (
				xmlTextIssue(node.data) !== undefined ||
				node.data.includes("--") ||
				node.data.endsWith("-")
			) {
				throw new Error("Malformed XML comment.");
			}
			return `<!--${node.data}-->`;
		case "directive":
			if (
				!node.name.startsWith("?") ||
				!node.data.startsWith("?") ||
				!node.data.endsWith("?") ||
				node.data.slice(1, -1).includes("?>") ||
				xmlTextIssue(node.data) !== undefined
			) {
				throw new Error("Unsupported XML processing instruction.");
			}
			return `<${node.data}>`;
		default:
			throw new Error(`Unsupported XML node: ${String(node satisfies never)}.`);
	}
}
