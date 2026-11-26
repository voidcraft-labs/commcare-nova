/**
 * Contract: the gate admits a Search field Web Apps does not draw exactly
 * where its prompt reads back as that field. A hidden prompt with no widget
 * left out of the request (`exclude`) is a hidden value the search never
 * matches, so a hidden text field rides the bare prompt; and nothing a
 * worker in Web Apps would have to see (a hint, a requirement, a check, the
 * box to also find blank) stands on a row Web Apps hides whole.
 *
 * The failure it catches: a hidden text field matched through
 * `_xpath_query` admitted, which HQ's build writes with `exclude` and the
 * reader reads back as a hidden value; the domain's reason and the wire's
 * own decision of which prompt carries `exclude` drifting apart.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { searchInputSuppressesAutoMatch } from "@/lib/commcare/suite/case-search/searchPrompts";
import {
	hiddenSearchFieldRefusal,
	type SearchInputMode,
	searchInputDefSchema,
	type VisibleSearchInputDef,
} from "@/lib/domain";
import {
	ancestorPath,
	literal,
	matchAll,
	relationStep,
	term,
} from "@/lib/domain/expression";
import { proseText } from "@/lib/domain/prose";
import {
	admittedCaseListDoc,
	findings,
	withSearchInputs,
} from "./caseListRuleFixture";

const base = () =>
	admittedCaseListDoc({
		caseTypes: [
			{
				name: "patient",
				parent_type: "household",
				properties: [
					{ name: "region", label: proseText("Region"), data_type: "text" },
					{ name: "status", label: proseText("Status"), data_type: "text" },
				],
			},
			{
				name: "household",
				properties: [
					{ name: "region", label: proseText("Region"), data_type: "text" },
				],
			},
		],
	});

const CODE = "CASE_LIST_HIDDEN_SEARCH_FIELD_REFUSED";

function refusals(input: VisibleSearchInputDef) {
	return findings(withSearchInputs(base(), [input])).filter(
		(error) => error.code === CODE,
	);
}

describe("hidden Search field admission", () => {
	it("admits a hidden text field exactly where its prompt rides the bare key", () => {
		const modes: (SearchInputMode | undefined)[] = [
			undefined,
			{ kind: "exact" },
			{ kind: "fuzzy" },
			{ kind: "starts-with" },
		];
		let admitted = 0;
		let refused = 0;
		for (const property of ["region", "status"])
			for (const mode of modes)
				for (const projectSpace of [false, true])
					for (const cross of [false, true])
						for (const renamed of [false, true]) {
							const field = searchInputDefSchema.parse({
								uuid: testUuid("hidden"),
								kind: "simple",
								name: renamed ? "area" : property,
								label: "Region",
								type: "text",
								property,
								hidden: true,
								default: term(literal("north")),
								...(mode !== undefined && { mode }),
								...(projectSpace && { matching: "project-space" }),
								...(cross && { via: ancestorPath(relationStep("parent")) }),
							}) as VisibleSearchInputDef;
							const reason = hiddenSearchFieldRefusal(field);
							// The domain's reason is the wire's own decision of `exclude`.
							expect(reason === undefined, JSON.stringify(field)).toBe(
								!searchInputSuppressesAutoMatch(field),
							);
							const found = refusals(field);
							expect(found.length, JSON.stringify(field)).toBe(
								reason === undefined ? 0 : 1,
							);
							if (reason === undefined) admitted += 1;
							else {
								refused += 1;
								expect(found[0]?.details).toMatchObject({
									inputUuid: field.uuid,
									reason,
								});
							}
						}
		expect(admitted).toBeGreaterThan(0);
		expect(refused).toBeGreaterThan(0);
	});

	it("admits a hidden field with a widget whatever its match, an advanced one included", () => {
		const field = searchInputDefSchema.parse({
			uuid: testUuid("hidden-range"),
			kind: "advanced",
			name: "window",
			label: "Window",
			type: "date-range",
			hidden: true,
			predicate: matchAll(),
		}) as VisibleSearchInputDef;
		expect(refusals(field)).toEqual([]);
	});

	it.each([
		["a hint", { hint: "Never seen" }],
		["a requirement", { required: {} }],
		["a check", { validation: { rule: matchAll(), message: "No" } }],
		["a search for blank", { allowBlank: true }],
	])("refuses %s on a hidden field", (_name, slots) => {
		const field = searchInputDefSchema.parse({
			uuid: testUuid("hidden-shown"),
			kind: "simple",
			name: "region",
			label: "Region",
			type: "text",
			property: "region",
			hidden: true,
			...slots,
		}) as VisibleSearchInputDef;
		expect(refusals(field)).toHaveLength(1);
		const { hidden: _hidden, ...shown } = field;
		expect(refusals(shown as VisibleSearchInputDef)).toEqual([]);
	});
});
