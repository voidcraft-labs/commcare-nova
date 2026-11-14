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

/** Which way a source failed to parse: a document type declaration, an XML
 *  version other than 1.0, or markup that is not well-formed XML. */
export type XmlParseFailureKind = "doctype" | "xml-version" | "malformed";

/** A parse failure, with its kind set where the parser met it. */
export class XmlParseError extends Error {
	constructor(
		message: string,
		readonly kind: XmlParseFailureKind,
	) {
		super(message);
		this.name = "XmlParseError";
	}
}

/** The failure of one SAX callback, carried out of the parser with its kind. */
class Refused extends Error {
	constructor(
		message: string,
		readonly kind: XmlParseFailureKind,
	) {
		super(message);
	}
}

/**
 * Parse XML 1.0 with namespace scope into the DOM our structural rules walk.
 * SAXES owns decoding too: HTML parsers replace even legal XML character
 * references in the C1 range with Windows-1252 display characters.
 * Our wire resources have no DTD; refusing it also avoids pretending to
 * validate declarations or resolve entities this parser does not implement.
 * A failure is an `XmlParseError` whose `kind` says which of the three it is.
 */
export function parseXml(xml: string): Document {
	try {
		const parser = new SaxesParser({
			xmlns: true,
			defaultXMLVersion: "1.0",
			forceXMLVersion: true,
		});
		parser.on("doctype", () => {
			throw new Refused(
				"Document type declarations are not supported.",
				"doctype",
			);
		});
		parser.on("xmldecl", ({ version }) => {
			if (version !== "1.0")
				throw new Refused("Expected XML version 1.0.", "xml-version");
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
		throw new XmlParseError(
			`Malformed XML: ${error instanceof Error ? error.message : String(error)}`,
			error instanceof Refused ? error.kind : "malformed",
		);
	}
}

export function tryParseXml(
	xml: string,
): { doc: Document } | { issue: string; kind: XmlParseFailureKind } {
	try {
		return { doc: parseXml(xml) };
	} catch (error) {
		if (error instanceof XmlParseError)
			return { issue: error.message, kind: error.kind };
		throw error;
	}
}

export function xmlParseIssue(xml: string): string | undefined {
	const result = tryParseXml(xml);
	return "issue" in result ? result.issue : undefined;
}

export function assertXml(xml: string): void {
	parseXml(xml);
}
