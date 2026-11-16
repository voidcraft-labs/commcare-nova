import {
	type ChildNode,
	Comment,
	Document,
	Element,
	isTag,
	ProcessingInstruction,
	Text,
} from "domhandler";
import { appendChild } from "domutils";
import { SaxesParser } from "saxes";
import { HeldByText } from "./heldByText";

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

/**
 * Form texts whose parse is held: about two cap-size apps' worth of forms
 * that a reading parses again (its source's and Nova's emission's), each
 * parsed document some eight bytes for each character of its text.
 */
export const PARSED_FORM_TEXTS_HELD_CHARACTERS = 8 * 1024 * 1024;

const heldParses = new HeldByText<ReturnType<typeof tryParseXml>>(
	PARSED_FORM_TEXTS_HELD_CHARACTERS,
);

/** Every node of `node`, frozen, so no reader of a shared document can write it. */
function frozenTree(node: Document | ChildNode): void {
	Object.freeze(node);
	if ("attribs" in node) Object.freeze(node.attribs);
	if ("children" in node) {
		Object.freeze(node.children);
		for (const child of node.children) frozenTree(child);
	}
}

/**
 * `tryParseXml(xml)`, answered for a text parsed before with the document
 * that parse gave (`heldByText.ts`). The document is shared by every reader
 * of the text, the readings of other requests included, so it is frozen
 * whole: a reader reads it and never writes it, and one that needs a
 * document of its own (the reader of HQ's forms, for a second form of the
 * same text in one reading) takes `cloneNode(doc, true)`. A form's XForm text
 * is read this way by `hq/publishedCaseBlocks.ts`, `hq/sourceIdentity.ts`
 * and `reader/xform/index.ts`.
 */
export function heldXmlParse(xml: string): ReturnType<typeof tryParseXml> {
	return heldParses.of(xml, (text) => {
		const parsed = tryParseXml(text);
		if ("doc" in parsed) frozenTree(parsed.doc);
		return Object.freeze(parsed);
	});
}

export function xmlParseIssue(xml: string): string | undefined {
	const result = tryParseXml(xml);
	return "issue" in result ? result.issue : undefined;
}

export function assertXml(xml: string): void {
	parseXml(xml);
}
