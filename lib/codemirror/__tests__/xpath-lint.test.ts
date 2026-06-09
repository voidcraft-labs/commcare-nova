/**
 * Coverage for `caseTypePropsForValidation` — the single home of the
 * registration-narrowing rule the inline linter, the save gate, and the deep
 * validator all read. A registration form must collapse to the own (depth-0)
 * type's `case_id` only; every other form type exposes each reachable type's
 * full property set.
 */

import { describe, expect, it } from "vitest";
import type { ReachableCaseTypeIndex } from "@/lib/domain";
import {
	caseTypePropsForValidation,
	type XPathLintContext,
} from "../xpath-lint";

/** A reachable index: own `pregnancy` (depth 0) + ancestor `mother` (depth 1). */
const index: ReachableCaseTypeIndex = new Map([
	[
		"pregnancy",
		{
			depth: 0,
			properties: new Map([
				["edd", { label: "EDD" }],
				["ga_weeks", {}],
			]),
		},
	],
	["mother", { depth: 1, properties: new Map([["household_code", {}]]) }],
]);

function ctx(
	formType: XPathLintContext["formType"],
	reachableCaseTypes: ReachableCaseTypeIndex | undefined,
): XPathLintContext {
	return {
		formUuid: "f",
		validPaths: new Set(),
		reachableCaseTypes,
		formEntries: [],
		formType,
	};
}

describe("caseTypePropsForValidation", () => {
	it("narrows a registration form to the own type's case_id only", () => {
		const accept = caseTypePropsForValidation(ctx("registration", index));
		expect(accept).toBeDefined();
		expect([...(accept?.keys() ?? [])]).toEqual(["pregnancy"]);
		expect([...(accept?.get("pregnancy") ?? [])]).toEqual(["case_id"]);
	});

	it("exposes every reachable type's full property set on a non-registration form", () => {
		const accept = caseTypePropsForValidation(ctx("followup", index));
		expect([...(accept?.get("pregnancy") ?? [])].sort()).toEqual([
			"edd",
			"ga_weeks",
		]);
		expect([...(accept?.get("mother") ?? [])]).toEqual(["household_code"]);
	});

	it("returns undefined when the form has no case type", () => {
		expect(
			caseTypePropsForValidation(ctx("survey", undefined)),
		).toBeUndefined();
	});
});
