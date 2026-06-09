/**
 * Coverage for the case-type `#<type>/` autocomplete branch — specifically that
 * a registration form surfaces only the own type's `#<type>/case_id` (mirroring
 * the `caseRefAcceptMap` registration-narrowing rule the validator also uses)
 * while other form types surface the full property list.
 *
 * The source is driven through `@codemirror/autocomplete`'s
 * `CompletionContext`, mounted on an EditorState that has the XPath language
 * extension attached (the source resolves the syntax tree at the cursor
 * position to find a `HashtagRef`, so a parsed state is required).
 */

import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import type { ReachableCaseTypeIndex } from "@/lib/domain";
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

/** A reachable index with one own (depth 0) type `patient`. Seeds `case_id`
 *  (label "case id") the same way `toReachableIndex` does in production, so the
 *  fixture matches the real index shape. */
function patientIndex(
	properties: Array<[string, { label?: string }]>,
): ReachableCaseTypeIndex {
	const props = new Map(properties);
	if (!props.has("case_id")) props.set("case_id", { label: "case id" });
	return new Map([["patient", { depth: 0, properties: props }]]);
}

function makeLintContext(
	formType: XPathLintContext["formType"],
	properties: Array<[string, { label?: string }]> = [
		["case_id", { label: "case id" }],
		["age", { label: "Age" }],
		["weight", { label: "Weight" }],
	],
): XPathLintContext {
	return {
		formUuid: "test-form",
		validPaths: new Set(),
		reachableCaseTypes: patientIndex(properties),
		formEntries: [],
		formType,
	};
}

describe("hashtagSource — registration form filters to the own type's case_id only", () => {
	it("after typing `#patient/`, only `#patient/case_id` is offered", () => {
		const source = hashtagSource(() => makeLintContext("registration"));
		const result = source(ctxFor("#patient/"));
		expect(result).not.toBeNull();
		const labels = result?.options.map((o) => o.label) ?? [];
		expect(labels).toEqual(["#patient/case_id"]);
	});

	it("offers the seeded #patient/case_id with its 'case id' detail when the type declares nothing else", () => {
		// `case_id` is a seeded system property of every type, so it's offered
		// on a registration form even when the case-type record declares no
		// other properties.
		const source = hashtagSource(() => makeLintContext("registration", []));
		const result = source(ctxFor("#patient/"));
		expect(result?.options[0].label).toBe("#patient/case_id");
		expect(result?.options[0].detail).toBe("case id");
	});
});

describe("hashtagSource — case-loading forms surface all case properties", () => {
	for (const formType of ["followup", "close"] as const) {
		it(`offers every case property on a ${formType} form`, () => {
			const source = hashtagSource(() => makeLintContext(formType));
			const result = source(ctxFor("#patient/"));
			const labels = (result?.options.map((o) => o.label) ?? []).sort();
			expect(labels).toEqual([
				"#patient/age",
				"#patient/case_id",
				"#patient/weight",
			]);
		});
	}
});

describe("hashtagSource — survey forms offer no case properties", () => {
	it("offers nothing after `#patient/` (a survey loads no case)", () => {
		// A survey form's suite entry declares no `case_id` datum, so any
		// `#<type>/<prop>` would resolve against an empty session datum. The
		// accept map is empty for surveys (mirroring `caseRefAcceptMap`), so
		// the autocomplete offers no case properties even when the module the
		// survey sits in has a case type.
		const source = hashtagSource(() => makeLintContext("survey"));
		const result = source(ctxFor("#patient/"));
		expect(result).toBeNull();
	});
});
