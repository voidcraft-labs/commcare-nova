import { describe, expect, it } from "vitest";
import { expressionEditorFixture } from "@/__tests__/helpers/expressionEditorFixture";
import type { CaseType } from "@/lib/domain";
import {
	ancestorPath,
	count,
	relationStep,
	selfPath,
	subcasePath,
} from "@/lib/domain/expression";
import { slotContext } from "@/lib/domain/expression/context";
import {
	countDefault,
	hasCountableRelation,
} from "../cards/expression/CountCard";

const HOUSEHOLD: CaseType = { name: "household", properties: [] };
const PATIENT: CaseType = {
	name: "patient",
	parent_type: "household",
	properties: [],
};
const ORPHAN: CaseType = { name: "orphan", properties: [] };

describe("Count related cases — viable defaults", () => {
	it("starts with the declared parent when one exists", () => {
		expect(
			countDefault(
				expressionEditorFixture("calculated-column", {
					caseTypes: [HOUSEHOLD, PATIENT],
					currentCaseType: "patient",
					knownInputs: [],
				}).context,
			),
		).toEqual(count(ancestorPath(relationStep("parent"))));
	});

	it("starts with the first declared child when there is no parent", () => {
		expect(
			countDefault(
				expressionEditorFixture("calculated-column", {
					caseTypes: [HOUSEHOLD, PATIENT],
					currentCaseType: "household",
					knownInputs: [],
				}).context,
			),
		).toEqual(count(subcasePath("parent", "patient")));
	});

	it("keeps the total factory valid when no related case type exists", () => {
		expect(
			countDefault(
				expressionEditorFixture("calculated-column", {
					caseTypes: [ORPHAN],
					currentCaseType: "orphan",
					knownInputs: [],
				}).context,
			),
		).toEqual(count(selfPath()));
	});

	it("keeps new-target availability distinct from the total self fallback", () => {
		expect(
			hasCountableRelation(
				expressionEditorFixture("calculated-column", {
					caseTypes: [ORPHAN],
					currentCaseType: "orphan",
					knownInputs: [],
				}).context,
			),
		).toBe(false);
		expect(
			hasCountableRelation(
				expressionEditorFixture("calculated-column", {
					caseTypes: [HOUSEHOLD, PATIENT],
					currentCaseType: "household",
					knownInputs: [],
				}).context,
			),
		).toBe(true);
	});
});

it("offers device cases to a Search button without any record being selected", () => {
	const fixture = expressionEditorFixture("global-condition", {
		caseTypes: [ORPHAN],
		currentCaseType: "",
		knownInputs: [],
	});
	const expressionContext = slotContext(
		fixture.doc,
		{
			entity: "module",
			uuid: fixture.doc.moduleOrder[0],
			slot: "search_button_display_condition",
		},
		new Map(),
	);
	if (expressionContext === undefined)
		throw new Error("The Search button has no slot.");
	const context = { ...fixture.context, expressionContext };
	expect(hasCountableRelation(context)).toBe(true);
	expect(countDefault(context)).toEqual({
		kind: "count",
		via: { kind: "cases", source: "casedb", where: [] },
	});
});
