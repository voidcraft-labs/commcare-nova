// @vitest-environment happy-dom

/**
 * What the prose editor's `#` suggestion offers as a person types a record
 * reference in its long spelling, `#record/<type>/<property>`, which reads
 * any record type.
 *
 * Contract: the suggestion's items for a query are what the person can
 * choose next: after `record/` every readable type as `record/<type>`, and
 * after `record/<type>/` that type's properties, whatever the type is
 * called, as after its short spelling. The plausible failure is a query
 * read only against the short spellings, which offers nothing once
 * `record/` is typed for a type that is no fixed word. The observations are
 * the items the suggestion returns, through the production provider over a
 * form's reachable record types.
 */

import type { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import type { FormReferenceContext } from "@/lib/codemirror/formReferenceContext";
import {
	type CaseType,
	reachableCaseTypes,
	toReachableIndex,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { ReferenceProvider } from "@/lib/references/provider";
import { createRefSuggestion } from "../refSuggestion";

const CASE_TYPES: CaseType[] = [
	{
		name: "mother",
		properties: [
			{ name: "household_code", label: proseText("Household code") },
		],
	},
	{
		name: "case",
		parent_type: "mother",
		properties: [{ name: "region", label: proseText("Region") }],
	},
];

function context(): FormReferenceContext {
	return {
		formUuid: "visit",
		validPaths: new Set(),
		reachableCaseTypes: toReachableIndex(
			reachableCaseTypes("case", CASE_TYPES),
			{ fields: {}, forms: {}, fieldOrder: {} },
		),
		formEntries: [],
		formType: "followup",
	};
}

/** The suggestion's items for `query`, the text typed after `#`. */
function items(query: string): unknown[] {
	const provider = new ReferenceProvider((formUuid) =>
		formUuid === "visit" ? context() : undefined,
	);
	const suggestion = createRefSuggestion(provider, () => "visit");
	return (suggestion.items?.({
		query,
		editor: {} as Editor,
		signal: new AbortController().signal,
	}) ?? []) as unknown[];
}

describe("the prose editor's reference suggestion", () => {
	it("offers every readable type in its long spelling once record/ is typed", () => {
		expect(items("record/")).toMatchObject([
			{ kind: "namespace", namespace: "record/case", label: "#record/case/" },
			{
				kind: "namespace",
				namespace: "record/mother",
				label: "#record/mother/",
			},
		]);
		expect(items("record/mo")).toMatchObject([{ namespace: "record/mother" }]);
	});

	it("offers a type's properties after record/<type>/, whatever the type is called, as after its short spelling", () => {
		expect(items("record/mother/house")).toMatchObject([
			{ type: "case", caseType: "mother", path: "household_code" },
		]);
		expect(items("record/mother/house")).toEqual(items("mother/house"));
		expect(items("record/case/reg")).toMatchObject([
			{ type: "case", caseType: "case", path: "region" },
		]);
	});

	it("keeps the short spellings in the namespace stage before record/ is typed", () => {
		expect(
			items("").map((item) => (item as { namespace: string }).namespace),
		).toEqual(["form", "user", "record/case", "mother"]);
	});
});
