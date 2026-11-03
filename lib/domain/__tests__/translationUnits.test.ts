import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	makeTranslationUnitId,
	plainColumn,
	proseText,
	translationUnitsById,
} from "@/lib/domain";

const NAME = testUuid("translation-units-name");
const WEIGHT = testUuid("translation-units-weight");

/** A list whose second column, over `weight`, orders the list and is hidden
 *  from Results, shown on Details or not as `visibleInDetail` says. */
function listWithHiddenOrderColumn(visibleInDetail: boolean): BlueprintDoc {
	return buildDoc({
		appName: "Clinic",
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListMenuItem: {},
				caseListConfig: resolveCaseListConfig({
					columns: [
						plainColumn(NAME, "case_name", "Name"),
						plainColumn(WEIGHT, "weight", "Weight", {
							visibleInList: false,
							visibleInDetail,
							sort: { direction: "asc", priority: 0 },
						}),
					],
					searchInputs: [],
				}),
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "weight", label: proseText("Weight") },
				],
			},
		],
	});
}

describe("a case list column's header unit", () => {
	const header = makeTranslationUnitId("column", WEIGHT, "header");

	it("is not listed for a column hidden from both screens, though it orders the list", () => {
		// Its header reaches no screen: HQ's build writes a hidden field's
		// header empty, so there is nothing for a translator to translate.
		expect(
			translationUnitsById(listWithHiddenOrderColumn(false)).has(header),
		).toBe(false);
	});

	it("is listed for the same column shown on Details", () => {
		expect(
			translationUnitsById(listWithHiddenOrderColumn(true)).has(header),
		).toBe(true);
	});
});

const MENU = testUuid("translation-units-menu");
const REGISTER = testUuid("translation-units-register");

/** A searching menu with a follow-up form and a registration form its case
 *  list offers, with the two labels the module owns as given. */
function menuWithLabels(labels: {
	readonly entry?: string;
	readonly register?: string;
}): BlueprintDoc {
	return buildDoc({
		appName: "Clinic",
		modules: [
			{
				uuid: MENU,
				name: "Patients",
				caseType: "patient",
				caseListMenuItem:
					labels.entry === undefined ? {} : { label: labels.entry },
				caseListRegistrationForm: {
					formUuid: REGISTER,
					...(labels.register !== undefined && { label: labels.register }),
				},
				caseSearchConfig: { formsReadSearch: true },
				forms: [
					{ name: "Visit", type: "followup" },
					{ uuid: REGISTER, name: "Register", type: "registration" },
				],
			},
		],
	});
}

describe("the labels a module's case list owns", () => {
	const entry = makeTranslationUnitId(
		"module",
		MENU,
		"case-list-menu-item-label",
	);
	const register = makeTranslationUnitId(
		"module",
		MENU,
		"case-list-registration-label",
	);

	it("lists each label the module sets, owned by the module", () => {
		const units = translationUnitsById(
			menuWithLabels({ entry: "All patients", register: "Add a patient" }),
		);
		expect(units.get(entry)).toMatchObject({
			role: "case-list-menu-item-label",
			source: "All patients",
			owner: { kind: "module", moduleUuid: MENU },
			breadcrumb: ["Clinic", "Patients", "case list entry"],
		});
		expect(units.get(register)).toMatchObject({
			role: "case-list-registration-label",
			source: "Add a patient",
			owner: { kind: "module", moduleUuid: MENU },
		});
	});

	it("lists neither where the wire falls back to a name", () => {
		// The entry reads the module's name unit, the Register action the
		// form's, so a unit of their own would translate nothing.
		const units = translationUnitsById(menuWithLabels({}));
		expect(units.has(entry)).toBe(false);
		expect(units.has(register)).toBe(false);
	});
});
