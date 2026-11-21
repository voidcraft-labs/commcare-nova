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
import { recordFromEntries } from "@/lib/domain/records";
import { HeldByText } from "./heldByText";
import {
	XML_DOCUMENT_MAX_DEPTH,
	XML_DOCUMENT_MAX_NAMESPACE_DECLARATIONS,
	XML_DOCUMENT_MAX_NODES,
} from "./hq/bounds";

/** Which way a source failed to parse: a document type declaration, an XML
 *  version other than 1.0, markup that is not well-formed XML, or a document
 *  past one of the limits on what a parse builds (`XmlLimits`). */
export type XmlParseFailureKind =
	| "doctype"
	| "xml-version"
	| "malformed"
	| "over-limit";

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
 * What one parse may build, whatever the text: its nodes (each element,
 * attribute, text, comment and processing instruction), how deep its elements
 * nest, and its namespace declarations (`xmlns` and `xmlns:*` attributes).
 * A text's length bounds none of these: `<a/>` is one element in four
 * characters, and a namespace scope copies its parent's declarations
 * (`xmlNamespaces.ts::scopeOf`), so declarations cost their square.
 */
export interface XmlLimits {
	readonly nodes: number;
	readonly depth: number;
	readonly namespaceDeclarations: number;
}

/** The limits every parse takes unless it names others (`bounds.ts` states each number's reason). */
export const XML_DOCUMENT_LIMITS: XmlLimits = {
	nodes: XML_DOCUMENT_MAX_NODES,
	depth: XML_DOCUMENT_MAX_DEPTH,
	namespaceDeclarations: XML_DOCUMENT_MAX_NAMESPACE_DECLARATIONS,
};

/** A parsed document and the nodes it holds, as `XmlLimits` counts them. */
export interface ParsedXml {
	readonly doc: Document;
	readonly nodes: number;
}

/**
 * Parse XML 1.0 with namespace scope into the DOM our structural rules walk.
 * SAXES owns decoding too: HTML parsers replace even legal XML character
 * references in the C1 range with Windows-1252 display characters.
 * Our wire resources have no DTD; refusing it also avoids pretending to
 * validate declarations or resolve entities this parser does not implement.
 * A failure is an `XmlParseError` whose `kind` says which of the four it is.
 */
export function parseXml(
	xml: string,
	limits: XmlLimits = XML_DOCUMENT_LIMITS,
): Document {
	return parsedXml(xml, limits).doc;
}

/**
 * `parseXml` with the nodes it built. Each callback counts what it is about
 * to build before it builds it, so a document past a limit stops the parse
 * with nothing past the limit made.
 */
function parsedXml(xml: string, limits: XmlLimits): ParsedXml {
	let nodes = 0;
	let depth = 0;
	let declarations = 0;
	const add = (count: number) => {
		nodes += count;
		if (nodes > limits.nodes)
			throw new Refused(
				`The document holds more than ${limits.nodes} nodes.`,
				"over-limit",
			);
	};
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
			depth += 1;
			if (depth > limits.depth)
				throw new Refused(
					`The document nests elements more than ${limits.depth} deep.`,
					"over-limit",
				);
			const names = Object.keys(tag.attributes);
			for (const name of names)
				if (name === "xmlns" || name.startsWith("xmlns:")) declarations += 1;
			if (declarations > limits.namespaceDeclarations)
				throw new Refused(
					`The document declares more than ${limits.namespaceDeclarations} namespaces.`,
					"over-limit",
				);
			add(1 + names.length);
			const element = new Element(
				tag.name,
				recordFromEntries(
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
			depth -= 1;
			const parent = current.parent;
			if (parent === null || !(parent.type === "root" || isTag(parent)))
				throw new Error("Missing XML parent.");
			current = parent;
		});
		const addText = (value: string) => {
			if (current === doc) return;
			add(1);
			appendChild(current, new Text(value));
		};
		parser.on("text", addText);
		parser.on("cdata", addText);
		parser.on("comment", (value) => {
			add(1);
			appendChild(current, new Comment(value));
		});
		parser.on("processinginstruction", ({ target, body }) => {
			add(1);
			appendChild(
				current,
				new ProcessingInstruction(
					`?${target}`,
					`?${target}${body === "" ? "" : ` ${body}`}?`,
				),
			);
		});
		parser.write(xml).close();
		return { doc, nodes };
	} catch (error) {
		const kind = error instanceof Refused ? error.kind : "malformed";
		const said = error instanceof Error ? error.message : String(error);
		throw new XmlParseError(
			kind === "over-limit"
				? `XML larger than Nova parses: ${said}`
				: `Malformed XML: ${said}`,
			kind,
		);
	}
}

/** `parseXml`, its failure an answer: the issue and its kind. */
export function tryParseXml(
	xml: string,
	limits: XmlLimits = XML_DOCUMENT_LIMITS,
): ParsedXml | { issue: string; kind: XmlParseFailureKind } {
	try {
		return parsedXml(xml, limits);
	} catch (error) {
		if (error instanceof XmlParseError)
			return { issue: error.message, kind: error.kind };
		throw error;
	}
}

/**
 * The nodes of parsed form texts the process holds (`heldXmlParse`): about the
 * forms of one app at the byte cap (a 16 MiB source built as the cap tests
 * build theirs holds 121,500), some 25 MiB of trees at the 160 bytes a parsed node holds
 * (measured over the retained corpus's forms). Every reader of one form in a
 * reading shares its parse, and Nova's emission of the forms, which the fixed
 * point reads again, takes the room the source's held once the first reading,
 * which keeps its own documents, no longer needs it: the cache holds what will
 * be read next, and what it holds outlives a request, so it is weighed by
 * what it holds, never by the length of the texts.
 */
export const PARSED_FORM_NODES_HELD = 160_000;

const heldParses = new HeldByText<ReturnType<typeof tryParseXml>>(
	PARSED_FORM_NODES_HELD,
	(answer) => ("doc" in answer ? answer.nodes : 1),
);

/** Every node of `node`, frozen, so no reader of a shared document can write it.
 *  The parse bounds its depth (`XmlLimits.depth`), so the recursion does too. */
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
 * same text in one reading) takes `cloneNode(doc, true)`. Every form text
 * CommCare HQ holds is parsed here and nowhere else:
 * `hq/publishedCaseBlocks.ts`, `hq/sourceIdentity.ts`,
 * `reader/xform/index.ts` and the reading's own count of its forms' nodes
 * (`lib/deployment/reading/formStructure.ts`).
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
