import { describe, expect, it } from "vitest";
import { runValidation } from "@/lib/commcare/validator/runner";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	blueprintDocSchema,
	moduleFormsReadSearch,
	screenChoosesCaseFirst,
} from "@/lib/domain";
import { caseSelectionRowAction } from "@/lib/preview/caseSelectionNavigation";
import {
	previewParentCaseBeforeMenu,
	previewParentCaseListHasDetails,
} from "@/lib/preview/engine/parentCaseSelection";
import {
	previewCaseListContinuation,
	previewCaseListReturn,
	previewMenuScreenChoice,
} from "@/lib/preview/menuProjection";
import { previewPinnedCaseTile } from "@/lib/preview/pinnedCaseTile";
import { previewPlatformRules } from "@/lib/preview/platform";
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

	it("gives Pregnancy follow-ups a menu of its own that lists its forms first and asks Clinic patients' list for the patient, going on at the row", () => {
		const { pregnancyFollowUps, clinic } = MENU_HELD_CASE_SEED;
		expect(
			screenChoosesCaseFirst(doc, {
				kind: "menu",
				moduleUuid: pregnancyFollowUps.moduleUuid,
			}),
		).toBe(false);
		expect(
			previewParentCaseBeforeMenu(doc, pregnancyFollowUps.moduleUuid),
		).toBe(false);
		const mod = doc.modules[pregnancyFollowUps.moduleUuid];
		expect(mod?.parentModuleUuid).toBeUndefined();
		expect(mod?.parentCaseModuleUuid).toBe(clinic.moduleUuid);
		// Clinic patients' own list opens details; as the follow-up's parent
		// list, its row goes on at once.
		expect(
			previewParentCaseListHasDetails(doc, {
				selectorModuleUuid: clinic.moduleUuid,
				requestingModuleUuid: pregnancyFollowUps.moduleUuid,
				formUuid: pregnancyFollowUps.formUuid,
			}),
		).toBe(false);
	});

	it("gives Clinic patients a list that keeps its tile and opens each patient's details", () => {
		const { clinic } = MENU_HELD_CASE_SEED;
		const columns = doc.modules[clinic.moduleUuid]?.caseListConfig?.columns;
		expect(
			caseSelectionRowAction({
				hasDetails: (columns ?? []).some(
					(column) => column.visibleInDetail !== false,
				),
				multiple: false,
				canContinue: true,
			}),
		).toBe("detail");
		const viewing = {
			moduleUuid: clinic.moduleUuid,
			caseId: "ada",
			datum: "list",
		} as const;
		expect(
			previewPinnedCaseTile(
				doc.modules,
				[],
				"case-details",
				previewPlatformRules("android"),
				viewing,
			),
		).toEqual({ moduleUuid: clinic.moduleUuid, caseId: "ada" });
		expect(
			previewPinnedCaseTile(
				doc.modules,
				[],
				"case-details",
				previewPlatformRules("web-apps"),
				viewing,
			),
		).toBe(undefined);
	});

	it("gives Pregnancy visits a list that keeps its tile under a patient whose list keeps one too, so its form pins the patient's", () => {
		const { pregnancyVisits } = MENU_HELD_CASE_SEED;
		const mod = doc.modules[pregnancyVisits.moduleUuid];
		expect(mod?.caseListConfig?.tile?.persistOnForms).toBe(true);
		expect(mod?.parentCaseModuleUuid).toBe(patients.moduleUuid);
		/* The form's session: the patient Patients' list chose, then the
		 * pregnancy Pregnancy visits' list chose. The form's own module keeps
		 * its tile, so a rule reading the form's own module would pin the
		 * pregnancy; CommCare pins the earliest. */
		expect(
			previewPinnedCaseTile(
				doc.modules,
				[
					{
						moduleUuid: patients.moduleUuid,
						cases: [{ caseId: "ada" }],
					},
					{
						moduleUuid: pregnancyVisits.moduleUuid,
						cases: [{ caseId: "first-pregnancy" }],
					},
				],
				"form",
				previewPlatformRules("web-apps"),
			),
		).toEqual({ moduleUuid: patients.moduleUuid, caseId: "ada" });
	});

	it("gives Clinic search a list that keeps its tile and a Search action its forms do not read", () => {
		const mod = doc.modules[MENU_HELD_CASE_SEED.clinicSearch.moduleUuid];
		expect(mod?.caseListConfig?.tile?.persistOnForms).toBe(true);
		expect(mod?.caseListConfig?.searchInputs).toHaveLength(1);
		expect(mod !== undefined && moduleFormsReadSearch(mod)).toBe(false);
		expect(
			previewPinnedCaseTile(
				doc.modules,
				[],
				"case-details",
				previewPlatformRules("android"),
				{
					moduleUuid: MENU_HELD_CASE_SEED.clinicSearch.moduleUuid,
					caseId: "ada",
					datum: "search-results",
				},
			),
		).toBe(undefined);
	});
});
