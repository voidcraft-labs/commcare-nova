/**
 * Where a module's menu lands a worker who chooses it
 * (`navigation.ts::moduleDestination`), which App Tests and the after-submit
 * reads follow. The contract is Core's: a screen that asks for its case first
 * opens on its case list before it lists anything, submenu tiles included,
 * because a submenu is a `<menu root>` of its own and no entry of the screen's
 * command (`CommCareSession.getNeededData`); its menu shows once the case is
 * chosen. `MenuScreensRuntimeTest` holds the same landing to Core over the
 * `menu-screens` documents.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, type FormSpec } from "@/lib/__tests__/docHelpers";
import { moduleDestination } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

const followup = (label: string): FormSpec => ({
	uuid: label,
	name: label,
	type: "followup",
	fields: [{ kind: "text", id: "note", label: "Note" }],
});

/** "Wards", case first, with a submenu "Beds" that keeps its screen; and
 *  "Clinics", only its case list, with a submenu "Rooms". */
function wardsAndClinics() {
	const doc = buildDoc({
		caseTypes: [
			{
				name: "ward",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
			{
				name: "clinic",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
		modules: [
			{
				uuid: "wards",
				name: "Wards",
				caseType: "ward",
				forms: [followup("ward-round")],
			},
			{
				uuid: "beds",
				name: "Beds",
				caseType: "ward",
				forms: [followup("bed-check")],
			},
			{
				uuid: "clinics",
				name: "Clinics",
				caseType: "clinic",
				caseListMenuItem: {},
				forms: [],
			},
			{
				uuid: "rooms",
				name: "Rooms",
				caseType: "clinic",
				forms: [followup("room-check")],
			},
		],
	});
	doc.modules[testUuid("beds")].parentModuleUuid = testUuid("wards");
	doc.modules[testUuid("rooms")].parentModuleUuid = testUuid("clinics");
	return doc;
}

describe("moduleDestination", () => {
	it("opens a case-first parent on its case list, and on its menu once its case is chosen", () => {
		const doc = wardsAndClinics();
		const wards = testUuid("wards");
		expect(moduleDestination(doc, wards)).toEqual({
			screen: "results",
			moduleUuid: wards,
			name: "Wards",
			withSelectedRecord: "menu",
		});
		expect(moduleDestination(doc, wards, true)).toEqual({
			screen: "menu",
			moduleUuid: wards,
			name: "Wards",
		});
	});

	it("opens a case list menu with a submenu on its list, and on its submenus once its case is chosen", () => {
		const doc = wardsAndClinics();
		const clinics = testUuid("clinics");
		expect(moduleDestination(doc, clinics)).toMatchObject({
			screen: "results",
			withSelectedRecord: "menu",
		});
		expect(moduleDestination(doc, clinics, true)).toMatchObject({
			screen: "menu",
		});
	});
});
