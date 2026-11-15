import { describe, expect, it } from "vitest";
import { runValidation } from "@/lib/commcare/validator/runner";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { blueprintDocSchema, screenChoosesCaseFirst } from "@/lib/domain";
import {
	previewCaseListContinuation,
	previewCaseListReturn,
	previewMenuScreenChoice,
} from "@/lib/preview/menuProjection";
import {
	buildMenuHeldCaseBlueprint,
	MENU_HELD_CASE_SEED,
} from "./menuHeldCaseSeed";

const APP_ID = "5f3c1d2e-8a4b-4c6d-9e0f-1a2b3c4d5e6f";

describe("the menu-holding-a-case smoke seed", () => {
	const doc = buildMenuHeldCaseBlueprint(APP_ID);
	const { patients, visits, pregnancies } = MENU_HELD_CASE_SEED;

	it("is a persistable app with no validator findings", () => {
		const persistable = toPersistableDoc(doc);
		expect(blueprintDocSchema.parse(persistable)).toEqual(persistable);
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	});

	it("is the shape its journey claims: a case-first menu with a submenu that lists its forms first and goes back to the parent's list", () => {
		expect(
			screenChoosesCaseFirst(doc, {
				kind: "menu",
				moduleUuid: patients.moduleUuid,
			}),
		).toBe(true);
		expect(
			screenChoosesCaseFirst(doc, {
				kind: "menu",
				moduleUuid: visits.moduleUuid,
			}),
		).toBe(false);
		expect(previewCaseListContinuation(doc, patients.moduleUuid)).toBe(
			"menu-selection",
		);
		// Pregnancies chooses its pregnancy first, among the patient's, and
		// goes on into its own form menu: a form chosen there leaves a target
		// from a list's own form menu behind.
		expect(
			screenChoosesCaseFirst(doc, {
				kind: "menu",
				moduleUuid: pregnancies.moduleUuid,
			}),
		).toBe(true);
		expect(previewCaseListContinuation(doc, pregnancies.moduleUuid)).toBe(
			"form-menu",
		);
		const source = { ...doc, doc, caseTypes: doc.caseTypes ?? [] };
		const selections = {
			[patients.moduleUuid]: {
				caseType: MENU_HELD_CASE_SEED.caseType,
				cases: [{ caseId: "ada" }],
			},
		};
		const target = {
			formUuid: visits.formUuid,
			cases: [{ caseId: "ada" }],
			formChosenAfterCase: previewMenuScreenChoice(
				source,
				visits.moduleUuid,
				selections,
			),
		};
		expect(
			previewCaseListReturn(target, {
				moduleUuid: visits.moduleUuid,
				formUuid: visits.formUuid,
			}).moduleUuid,
		).toBe(patients.moduleUuid);
	});
});
