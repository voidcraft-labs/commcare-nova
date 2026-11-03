// The own arm's write overflow, held to the commit gate. Catches an item that
// is offered and then refused (or the reverse), a menu on a form whose own
// case can't save above itself, and a Save only if changed offered while
// CommCare HQ keeps the change in Save to Case, which has no such setting.

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	ancestorCaseWriteChoices,
	KEPT_IN_SAVE_TO_CASE_REASON,
	SAVE_ONLY_IF_CHANGED_LINE,
} from "@/components/builder/editor/fields/caseWriteRowModel";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	caseOperationEditVerdict,
	planCaseOperationUpdate,
} from "@/lib/doc/caseOperationMutations";
import { formCasePlacementView } from "@/lib/doc/casePlacements";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import type { BlueprintDoc } from "@/lib/doc/types";
import {
	effectiveCaseTypes,
	type Form,
	type OwnCaseOperation,
	type Uuid,
} from "@/lib/domain";
import { concat, formField, literal, term } from "@/lib/domain/expression";
import {
	NO_CASE_ABOVE_REASON,
	ownWriteMenu,
	THIS_FORMS_CASE_LABEL,
	viaDestinationLine,
} from "../ownWriteMenuModel";

const FUP = testUuid("own-menu-followup");
const REG = testUuid("own-menu-registration");
const NOTE = testUuid("own-menu-note");
const NAME = testUuid("own-menu-name");

function fixture(formType: Form["type"] = "followup"): BlueprintDoc {
	return buildDoc({
		caseTypes: [
			{
				name: "village",
				properties: [{ name: "note", label: "Village note" }],
			},
			{
				name: "household",
				parent_type: "village",
				relationship: "child",
				properties: [{ name: "note", label: "Note" }],
			},
		],
		modules: [
			{
				name: "Households",
				caseType: "household",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: REG,
						name: "Register",
						type: "registration",
						fields: [
							f({
								uuid: NAME,
								kind: "text",
								id: "hh_name",
								caseWrite: { caseType: "household", property: "case_name" },
							}),
						],
					},
					{
						uuid: FUP,
						name: "Visit",
						type: formType,
						fields: [
							f({
								uuid: NOTE,
								kind: "text",
								id: "note",
								caseWrite: { caseType: "household", property: "note" },
							}),
						],
					},
				],
			},
		],
	});
}

function ownOf(doc: BlueprintDoc, formUuid: Uuid): OwnCaseOperation {
	const own = doc.forms[formUuid]?.caseOperations?.find(
		(operation): operation is OwnCaseOperation => operation.action === "own",
	);
	if (own === undefined) throw new Error("The form has no own case");
	return own;
}

function menuOf(doc: BlueprintDoc, formUuid: Uuid, formType: Form["type"]) {
	return ownWriteMenu({
		formType,
		own: ownOf(doc, formUuid),
		writeIndex: 0,
		ancestors: ancestorCaseWriteChoices(
			effectiveCaseTypes(doc),
			"household",
			formType,
		),
		ownHome: formCasePlacementView(doc, formUuid).own?.home,
		verdict: (operation) => caseOperationEditVerdict(doc, formUuid, operation),
	});
}

/** The item's operation committed as the canvas commits it: the update
 *  planner, then the gate. */
function land(
	doc: BlueprintDoc,
	formUuid: Uuid,
	next: OwnCaseOperation,
): BlueprintDoc {
	const plan = planCaseOperationUpdate(doc, formUuid, next);
	if (!plan.ok) throw new Error(plan.reason);
	const verdict = mutationCommitVerdict(
		doc,
		[...plan.mutations],
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok ? [] : verdict.findings).toEqual([]);
	return produce(doc, (draft) => {
		applyMutations(draft, [...plan.mutations]);
	});
}

describe("the own arm's write overflow", () => {
	it("offers this form's case and the case above it, and moving there lands", () => {
		const doc = fixture();
		const menu = menuOf(doc, FUP, "followup");
		expect(menu?.above.unavailableReason).toBeUndefined();
		expect(menu?.above.items.map((item) => [item.label, item.current])).toEqual(
			[
				[THIS_FORMS_CASE_LABEL, true],
				["village (parent)", false],
			],
		);
		const village = menu?.above.items[1];
		expect(village?.disabledReason).toBeUndefined();
		if (village === undefined) throw new Error("No village item");
		const moved = land(doc, FUP, village.next);
		expect(ownOf(moved, FUP).writes).toEqual([
			expect.objectContaining({
				property: "note",
				via: [{ identifier: "parent" }],
			}),
		]);

		// And back again: the item for this form's case drops the `via`.
		const back = menuOf(moved, FUP, "followup")?.above.items[0];
		expect(back).toMatchObject({ current: false });
		if (back === undefined) throw new Error("No item for this form's case");
		const returned = land(moved, FUP, back.next);
		expect(ownOf(returned, FUP).writes?.[0]?.via).toBeUndefined();
	});

	it("turns Save only if changed on and off, each landing", () => {
		const doc = fixture();
		const item = menuOf(doc, FUP, "followup")?.onlyIfChanged;
		expect(item).toMatchObject({ on: false, line: SAVE_ONLY_IF_CHANGED_LINE });
		expect(item?.disabledReason).toBeUndefined();
		if (item === undefined) throw new Error("No switch");
		const on = land(doc, FUP, item.next);
		expect(ownOf(on, FUP).writes?.[0]?.onlyIfChanged).toBe(true);
		const off = menuOf(on, FUP, "followup")?.onlyIfChanged;
		expect(off?.on).toBe(true);
		if (off === undefined) throw new Error("No switch");
		const cleared = land(on, FUP, off.next);
		expect(ownOf(cleared, FUP).writes?.[0]).not.toHaveProperty("onlyIfChanged");
	});

	it("refuses Save only if changed while CommCare HQ keeps the change in Save to Case", () => {
		// A computed value moves the own change to Save to Case.
		const doc = produce(fixture(), (draft) => {
			const own = draft.forms[FUP]?.caseOperations?.[0];
			if (own?.writes?.[0] === undefined) throw new Error("No write");
			own.writes[0].value = concat(term(formField(NOTE)), term(literal("!")));
		});
		expect(formCasePlacementView(doc, FUP).own?.home).toBe("save-to-case");
		expect(menuOf(doc, FUP, "followup")?.onlyIfChanged.disabledReason).toBe(
			KEPT_IN_SAVE_TO_CASE_REASON,
		);
	});

	it("says why no case above it is offered where the catalog has none", () => {
		const doc = produce(fixture(), (draft) => {
			const household = draft.caseTypes?.find(
				(caseType) => caseType.name === "household",
			);
			if (household === undefined) throw new Error("No household");
			delete household.parent_type;
			delete household.relationship;
		});
		const menu = menuOf(doc, FUP, "followup");
		expect(menu?.above).toMatchObject({
			items: [],
			unavailableReason: NO_CASE_ABOVE_REASON,
		});
	});

	it("is absent on a registration, whose new case has nothing above it yet", () => {
		const doc = fixture();
		expect(menuOf(doc, REG, "registration")).toBeUndefined();
	});

	it("names where a write through via saves", () => {
		expect(viaDestinationLine("village", [{ identifier: "parent" }])).toBe(
			"Saves onto the village it belongs to.",
		);
		expect(
			viaDestinationLine("district", [
				{ identifier: "parent" },
				{ identifier: "parent" },
			]),
		).toBe("Saves onto the district above it.");
	});
});
