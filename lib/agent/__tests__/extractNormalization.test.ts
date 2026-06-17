// lib/agent/__tests__/extractNormalization.test.ts
//
// Unit tests for the over-escape repair: the summarizer sometimes returns a large
// structured extract DOUBLE-escaped (the whole body as one physical line of literal
// `\n`/`\"` escape sequences). `normalizeExtractText` decodes that one escape level
// — but ONLY on the unambiguous corruption signature (no real newline + a literal
// `\n`), leaving every well-formed extract byte-identical.

import { describe, expect, it } from "vitest";
import { normalizeExtractText } from "@/lib/agent/extractNormalization";

describe("normalizeExtractText", () => {
	it("decodes a double-escaped single-line extract to real markdown", () => {
		// Literal `\n` (backslash-n) line breaks and `\"` (backslash-quote) quotes —
		// the exact shape Gemini emits for a large structured extract.
		const corrupted =
			'## Conflicts\\n* The vendor offers a \\"starts with\\" function.\\n* Second.';
		expect(normalizeExtractText(corrupted)).toBe(
			'## Conflicts\n* The vendor offers a "starts with" function.\n* Second.',
		);
	});

	it("leaves a well-formed extract byte-identical", () => {
		const clean = '## Conflicts\n* A real "quote" and a line break.\n* Second.';
		expect(normalizeExtractText(clean)).toBe(clean);
	});

	it("is idempotent — repairing twice equals repairing once", () => {
		const corrupted = "## A\\n* one\\n* two";
		const once = normalizeExtractText(corrupted);
		expect(normalizeExtractText(once)).toBe(once);
	});

	it("decodes every standard JSON escape, not just newlines", () => {
		// Tabs and backslashes ride the same one-level over-escape as newlines.
		const corrupted = "a\\tb\\\\c\\nd"; // a \t b \\ c \n d (all literal escapes)
		expect(normalizeExtractText(corrupted)).toBe("a\tb\\c\nd");
	});

	it("leaves a single-line extract with no escapes untouched", () => {
		const plain = "This document contains no extractable requirements.";
		expect(normalizeExtractText(plain)).toBe(plain);
	});

	it("does not touch a literal backslash-n that sits beside real newlines", () => {
		// A real multi-line extract is never the corrupted form, so even a genuine
		// `\n` in its content (e.g. a regex example) survives unchanged.
		const withRealBreaks = "Pattern: match `\\n` here.\n* Next line.";
		expect(normalizeExtractText(withRealBreaks)).toBe(withRealBreaks);
	});
});
