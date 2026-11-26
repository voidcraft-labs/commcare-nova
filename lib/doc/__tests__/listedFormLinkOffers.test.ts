/**
 * The deep link picker's offer for a form a menu lists from another menu,
 * held to the commit gate. CommCare HQ's menu settings page cannot save a
 * listing menu's own form links where the menu listed has no case type
 * (`basicCaseSlots.ts::listedFormLinksSavable`), so the picker shows that
 * destination disabled with the way forward, and offers it where the menu
 * listed has a case type, its forms all surveys or not. What the picker
 * offers lands; what it disables the gate refuses.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { planEntryPointAdd } from "@/lib/doc/entryPointMutations";
import { entryPointDestination } from "@/lib/doc/entryPointReview";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	type EntryPointTarget,
	suggestEntryPointId,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

const SURVEYS = testUuid("picker-listed-surveys");
const NOTES = testUuid("picker-listed-notes");
const LISTING = testUuid("picker-listing");

/** Surveys and its one survey form, listed by Clinic, which holds no form link yet. */
function surveysListed(caseType?: string): BlueprintDoc {
	const doc = buildDoc({
		...(caseType !== undefined && {
			caseTypes: [
				{
					name: caseType,
					properties: [{ name: "case_name", label: proseText("Site name") }],
				},
			],
		}),
		modules: [
			{
				uuid: SURVEYS,
				name: "Surveys",
				...(caseType !== undefined && {
					caseType,
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
				}),
				forms: [
					{
						uuid: NOTES,
						name: "Notes",
						type: "survey",
						fields: [f({ id: "note", kind: "text", label: proseText("Note") })],
					},
				],
			},
		],
	});
	doc.modules[LISTING] = {
		uuid: LISTING,
		id: "clinic",
		name: "Clinic",
		entryPoint: { uuid: testUuid("picker-listing-link"), id: "clinic" },
		...(caseType !== undefined && {
			caseListConfig: caseListConfig([{ field: "case_name", header: "Site" }]),
		}),
		formsFromMenu: { menuUuid: SURVEYS },
	};
	doc.moduleOrder.push(LISTING);
	doc.formOrder[LISTING] = [];
	return doc;
}

const target: EntryPointTarget = {
	kind: "form",
	moduleUuid: LISTING,
	formUuid: NOTES,
};

/** Whether adding the destination's deep link passes the commit gate. */
function lands(doc: BlueprintDoc): boolean {
	const plan = planEntryPointAdd(doc, target, {
		uuid: testUuid("picker-listing-form-link"),
		id: suggestEntryPointId(doc, target),
	});
	return (
		plan.ok &&
		mutationCommitVerdict(doc, [...plan.mutations], LOOKUP_CONTEXT_UNAVAILABLE)
			.ok
	);
}

describe("the deep link picker's offer for a listed form", () => {
	it("is disabled, naming the listing and the menu it lists, where that menu has no case type", () => {
		const doc = surveysListed();
		expect(entryPointDestination(doc, target).issue).toBe(
			"CommCare HQ can't save “Clinic” with deep links to single forms while “Surveys” tracks no cases. You can give this form its deep link in “Surveys” instead.",
		);
		expect(lands(doc)).toBe(false);
	});

	it("is offered where the menu listed has a case type though its forms are all surveys", () => {
		const doc = surveysListed("site");
		expect(entryPointDestination(doc, target).issue).toBe(undefined);
		expect(lands(doc)).toBe(true);
	});
});
