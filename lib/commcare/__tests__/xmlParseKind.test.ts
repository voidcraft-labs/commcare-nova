/**
 * Which way a source failed to parse.
 *
 * Contract: `tryParseXml` answers a failure's kind where the parser met it, a
 * document type declaration as `doctype`, an XML version other than 1.0 as
 * `xml-version`, a document past one of its limits (nodes, depth, namespace
 * declarations) as `over-limit`, and anything not well formed as
 * `malformed`, and never reads a kind from a message: a malformed source
 * whose text spells the other failures' messages is still `malformed`. The
 * message `xmlParseIssue` and `parseXml`'s error carry is the text callers
 * read today. A document at each limit parses, one past it does not, and the
 * parse stops before it builds anything past the limit; a parse answers the
 * nodes it built, which is what the process's cache of parses is weighed by.
 */

import { describe, expect, it } from "vitest";
import {
	XML_DOCUMENT_MAX_DEPTH,
	XML_DOCUMENT_MAX_NAMESPACE_DECLARATIONS,
	XML_DOCUMENT_MAX_NODES,
} from "../hq/bounds";
import {
	parseXml,
	tryParseXml,
	XML_DOCUMENT_LIMITS,
	XmlParseError,
	xmlParseIssue,
} from "../xmlParse";

/** `depth` elements, each inside the one before. */
function nested(depth: number): string {
	return `${"<a>".repeat(depth)}${"</a>".repeat(depth)}`;
}

/** A root holding `count` empty elements: `count + 1` nodes. */
function wide(count: number): string {
	return `<r>${"<a/>".repeat(count)}</r>`;
}

/** A root declaring `count` namespaces. */
function declaring(count: number): string {
	const declarations = Array.from(
		{ length: count },
		(_, index) => ` xmlns:p${index}="urn:p${index}"`,
	).join("");
	return `<r${declarations}/>`;
}

describe("tryParseXml's failure kinds", () => {
	it.each([
		[
			"a document type declaration",
			'<?xml version="1.0"?><!DOCTYPE h [<!ENTITY a "b">]><h/>',
			"doctype",
			"Malformed XML: Document type declarations are not supported.",
		],
		[
			"an XML 1.1 declaration",
			'<?xml version="1.1"?><h/>',
			"xml-version",
			"Malformed XML: Expected XML version 1.0.",
		],
	] as const)("names %s", (_label, xml, kind, issue) => {
		expect(tryParseXml(xml)).toEqual({ issue, kind });
		expect(xmlParseIssue(xml)).toBe(issue);
	});

	it("names unclosed markup malformed, whatever its text says", () => {
		const xml =
			"<h>Document type declarations are not supported. Expected XML version 1.0.";
		const result = tryParseXml(xml);
		expect(result).toMatchObject({ kind: "malformed" });
		expect(
			"issue" in result && result.issue.startsWith("Malformed XML: "),
		).toBe(true);
	});

	it("throws the kind with the message from parseXml", () => {
		let thrown: unknown;
		try {
			parseXml('<?xml version="1.1"?><h/>');
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(XmlParseError);
		expect(thrown).toMatchObject({
			kind: "xml-version",
			message: "Malformed XML: Expected XML version 1.0.",
		});
	});

	it("parses a well-formed source", () => {
		const result = tryParseXml("<h><b/></h>");
		expect("doc" in result).toBe(true);
	});
});

describe("what one parse builds", () => {
	it("are the bounds' numbers by default", () => {
		expect(XML_DOCUMENT_LIMITS).toEqual({
			nodes: XML_DOCUMENT_MAX_NODES,
			depth: XML_DOCUMENT_MAX_DEPTH,
			namespaceDeclarations: XML_DOCUMENT_MAX_NAMESPACE_DECLARATIONS,
		});
	});

	it.each([
		[
			"nesting",
			nested(XML_DOCUMENT_MAX_DEPTH),
			nested(XML_DOCUMENT_MAX_DEPTH + 1),
		],
		["nodes", wide(XML_DOCUMENT_MAX_NODES - 1), wide(XML_DOCUMENT_MAX_NODES)],
		[
			"namespace declarations",
			declaring(XML_DOCUMENT_MAX_NAMESPACE_DECLARATIONS),
			declaring(XML_DOCUMENT_MAX_NAMESPACE_DECLARATIONS + 1),
		],
	] as const)(
		"parses a document at the limit of its %s and names one past it over-limit",
		(_label, at, past) => {
			expect("doc" in tryParseXml(at)).toBe(true);
			expect(tryParseXml(past)).toMatchObject({ kind: "over-limit" });
			let thrown: unknown;
			try {
				parseXml(past);
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(XmlParseError);
			expect(thrown).toMatchObject({ kind: "over-limit" });
		},
	);

	it("counts each element, attribute, text and comment it builds", () => {
		const parsed = tryParseXml('<r a="1" b="2">text<c/><!-- note --></r>');
		expect("doc" in parsed && parsed.nodes).toBe(6);
	});

	it("holds a parse to the limits it is given", () => {
		const limits = { nodes: 10, depth: 3, namespaceDeclarations: 1 };
		const parsed = tryParseXml(wide(9), limits);
		expect("doc" in parsed && parsed.nodes).toBe(10);
		expect(tryParseXml(wide(10), limits)).toMatchObject({
			kind: "over-limit",
		});
		expect(tryParseXml(nested(4), limits)).toMatchObject({
			kind: "over-limit",
		});
		expect(tryParseXml(declaring(2), limits)).toMatchObject({
			kind: "over-limit",
		});
	});

	it("stops a document whose depth would pass the stack of a recursive walk, as over-limit and no thrown RangeError", () => {
		expect(tryParseXml(nested(100_000))).toMatchObject({ kind: "over-limit" });
	});
});
