import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	ROUTE,
	SOURCE,
	twoMenus,
} from "@/lib/commcare/__tests__/menuFormRoutesFixture";
import type { BlueprintDoc } from "@/lib/domain";
import { caseParentSelectionVerdict } from "@/lib/domain/caseParentSelection";

const CLINICS = testUuid("clinics-menu");

/** Patients and clinics, with no catalog edge between the two types: the
 * catalog describes what this app writes, not every index on a device. */
function withClinics(doc: BlueprintDoc): BlueprintDoc {
	const clinics = buildDoc({
		modules: [
			{
				uuid: CLINICS,
				name: "Clinics",
				caseType: "clinic",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "check-clinic",
						name: "Check clinic",
						type: "followup",
						fields: [f({ id: "notes", kind: "text" })],
					},
				],
			},
		],
	});
	return {
		...doc,
		modules: { ...doc.modules, ...clinics.modules },
		forms: { ...doc.forms, ...clinics.forms },
		fields: { ...doc.fields, ...clinics.fields },
		formOrder: { ...doc.formOrder, ...clinics.formOrder },
		fieldOrder: { ...doc.fieldOrder, ...clinics.fieldOrder },
		moduleOrder: [...doc.moduleOrder, ...clinics.moduleOrder],
	};
}

describe("caseParentSelectionVerdict", () => {
	it("admits a menu of another record type the catalog does not name as the parent", () => {
		const doc = withClinics(twoMenus());
		expect(caseParentSelectionVerdict(doc, SOURCE, CLINICS)).toEqual({
			ok: true,
		});
	});

	it("judges a menu listing another menu's forms by its source's record type", () => {
		const doc = withClinics(twoMenus());
		expect(caseParentSelectionVerdict(doc, ROUTE, CLINICS)).toEqual({
			ok: true,
		});
		expect(caseParentSelectionVerdict(doc, CLINICS, ROUTE)).toEqual({
			ok: true,
		});
		expect(caseParentSelectionVerdict(doc, ROUTE, SOURCE)).toMatchObject({
			ok: false,
		});
	});

	it("refuses a selection route that returns to the menu itself", () => {
		const doc = withClinics(twoMenus());
		const clinics = doc.modules[CLINICS];
		if (!clinics) throw new Error("fixture lost its menu");
		doc.modules[CLINICS] = { ...clinics, parentCaseModuleUuid: SOURCE };
		expect(caseParentSelectionVerdict(doc, SOURCE, CLINICS)).toMatchObject({
			ok: false,
			message:
				"Parent selection cannot return to a module already in its route.",
		});
	});
});
