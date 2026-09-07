import {
	Comment,
	Document,
	Element,
	isTag,
	ProcessingInstruction,
	Text,
} from "domhandler";
import { appendChild } from "domutils";
import { SaxesParser } from "saxes";

/**
 * Parse XML 1.0 with namespace scope into the DOM our structural rules walk.
 * SAXES owns decoding too: HTML parsers replace even legal XML character
 * references in the C1 range with Windows-1252 display characters.
 * Our wire resources have no DTD; refusing it also avoids pretending to
 * validate declarations or resolve entities this parser does not implement.
 */
export function parseXml(xml: string): Document {
	try {
		const parser = new SaxesParser({
			xmlns: true,
			defaultXMLVersion: "1.0",
			forceXMLVersion: true,
		});
		parser.on("doctype", () => {
			throw new Error("Document type declarations are not supported.");
		});
		parser.on("xmldecl", ({ version }) => {
			if (version !== "1.0") throw new Error("Expected XML version 1.0.");
		});
		const doc = new Document([]);
		let current: Document | Element = doc;
		parser.on("opentag", (tag) => {
			const element = new Element(
				tag.name,
				Object.fromEntries(
					Object.entries(tag.attributes).map(([name, attribute]) => [
						name,
						attribute.value,
					]),
				),
				[],
			);
			appendChild(current, element);
			current = element;
		});
		parser.on("closetag", () => {
			const parent = current.parent;
			if (parent === null || !(parent.type === "root" || isTag(parent)))
				throw new Error("Missing XML parent.");
			current = parent;
		});
		const addText = (value: string) => {
			if (current !== doc) appendChild(current, new Text(value));
		};
		parser.on("text", addText);
		parser.on("cdata", addText);
		parser.on("comment", (value) => {
			appendChild(current, new Comment(value));
		});
		parser.on("processinginstruction", ({ target, body }) => {
			appendChild(
				current,
				new ProcessingInstruction(
					`?${target}`,
					`?${target}${body === "" ? "" : ` ${body}`}?`,
				),
			);
		});
		parser.write(xml).close();
		return doc;
	} catch (error) {
		throw new Error(
			`Malformed XML: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export function tryParseXml(
	xml: string,
): { doc: Document } | { issue: string } {
	try {
		return { doc: parseXml(xml) };
	} catch (error) {
		return { issue: error instanceof Error ? error.message : String(error) };
	}
}

export function xmlParseIssue(xml: string): string | undefined {
	const result = tryParseXml(xml);
	return "issue" in result ? result.issue : undefined;
}

export function assertXml(xml: string): void {
	parseXml(xml);
}
