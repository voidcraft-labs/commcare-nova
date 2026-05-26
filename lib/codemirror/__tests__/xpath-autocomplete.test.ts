/**
 * Coverage for the `#case/` autocomplete branch — specifically that
 * registration forms surface only `#case/case_id` (mirroring the
 * `CASE_HASHTAG_ON_CREATE_FORM` doc-layer rule's accept set) while
 * other form types surface the full case-property list.
 *
 * The source is driven through `@codemirror/autocomplete`'s
 * `CompletionContext`, mounted on an EditorState that has the XPath
 * language extension attached (the source resolves the syntax tree at
 * the cursor position to find a `HashtagRef`, so a parsed state is
 * required).
 */

import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { hashtagSource } from "../xpath-autocomplete";
import { xpath } from "../xpath-language";
import type { XPathLintContext } from "../xpath-lint";

/**
 * Build a CompletionContext at the end of `doc` against an EditorState
 * that has the XPath language attached. `explicit=false` mimics the
 * "user typed a character" trigger CodeMirror uses by default.
 */
function ctxFor(doc: string): CompletionContext {
	const state = EditorState.create({ doc, extensions: [xpath()] });
	return new CompletionContext(state, doc.length, false);
}

function makeLintContext(
	formType: XPathLintContext["formType"],
): XPathLintContext {
	return {
		validPaths: new Set(),
		caseProperties: new Map([
			["case_id", { label: "case id" }],
			["age", { label: "Age" }],
			["weight", { label: "Weight" }],
		]),
		formEntries: [],
		formType,
	};
}

describe("hashtagSource — registration form filters to #case/case_id only", () => {
	it("after typing `#case/`, only `#case/case_id` is offered", () => {
		const source = hashtagSource(() => makeLintContext("registration"));
		const result = source(ctxFor("#case/"));
		expect(result).not.toBeNull();
		const labels = result?.options.map((o) => o.label) ?? [];
		expect(labels).toEqual(["#case/case_id"]);
	});

	it("falls back to a static `case id (newly allocated)` detail when the case-type record lacks a case_id property", () => {
		// `case_id` is normally surfaced by the case-type record on the
		// doc, but the autocomplete must still offer it even when the
		// map is missing the entry — `case_id` is the form-allocated id,
		// not a user-authored property.
		const lint: XPathLintContext = {
			...makeLintContext("registration"),
			caseProperties: new Map(),
		};
		const source = hashtagSource(() => lint);
		const result = source(ctxFor("#case/"));
		expect(result?.options[0].label).toBe("#case/case_id");
		expect(result?.options[0].detail).toContain("newly allocated");
	});
});

describe("hashtagSource — non-registration forms surface all case properties", () => {
	for (const formType of ["followup", "close", "survey"] as const) {
		it(`offers every case property on a ${formType} form`, () => {
			const source = hashtagSource(() => makeLintContext(formType));
			const result = source(ctxFor("#case/"));
			const labels = (result?.options.map((o) => o.label) ?? []).sort();
			expect(labels).toEqual(["#case/age", "#case/case_id", "#case/weight"]);
		});
	}
});
