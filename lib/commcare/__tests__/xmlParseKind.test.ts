/**
 * Which way a source failed to parse.
 *
 * Contract: `tryParseXml` answers a failure's kind where the parser met it, a
 * document type declaration as `doctype`, an XML version other than 1.0 as
 * `xml-version`, and anything not well formed as `malformed`, and never reads
 * a kind from a message: a malformed source whose text spells the other
 * failures' messages is still `malformed`. The message `xmlParseIssue` and
 * `parseXml`'s error carry is the text callers read today.
 */

import { describe, expect, it } from "vitest";
import {
	parseXml,
	tryParseXml,
	XmlParseError,
	xmlParseIssue,
} from "../xmlParse";

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
