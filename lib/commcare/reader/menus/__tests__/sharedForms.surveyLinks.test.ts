/**
 * A listing menu's deep links to single forms, read back from Nova's own
 * emission. CommCare HQ's menu settings page saves them only where the menu
 * listed has a case type (`is_surveys` reads the stored `case_type`), so the
 * reader holds them on a typed menu whose forms are all surveys, and the
 * read document passes the commit gate; on a menu with no case type it
 * refuses them at their place.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { runValidation } from "../../../validator/runner";
import { codesOf, moduleNamed, readMenusOf } from "./menuReading";

const SURVEYS = testUuid("read-listed-surveys");
const NOTES = testUuid("read-listed-surveys-notes");
const LISTING = testUuid("read-listed-surveys-route");

/** Surveys, its one survey form, and Clinic listing that form with its own link. */
function surveysListed(caseType?: string): BlueprintDoc {
	const doc = buildDoc({
		...(caseType !== undefined && {
			caseTypes: [{ name: caseType, properties: [] }],
		}),
		modules: [
			{
				uuid: SURVEYS,
				name: "Surveys",
				...(caseType !== undefined && { caseType }),
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
		entryPoint: { uuid: testUuid("read-listed-surveys-link"), id: "clinic" },
		formsFromMenu: {
			menuUuid: SURVEYS,
			entryPoints: [
				{
					formUuid: NOTES,
					entryPoint: {
						uuid: testUuid("read-listed-surveys-form-link"),
						id: "clinic_notes",
					},
				},
			],
		},
	};
	doc.moduleOrder.push(LISTING);
	doc.formOrder[LISTING] = [];
	return doc;
}

describe("a listing menu's deep links to single forms, read from CommCare HQ", () => {
	it("are held where the menu listed has a case type though its forms are all surveys, and pass the gate", async () => {
		const reading = await readMenusOf(surveysListed("site"));
		expect(codesOf(reading)).toEqual([]);
		const doc = reading.doc as BlueprintDoc;
		expect(moduleNamed(doc, "Surveys").caseType).toBe("site");
		expect(
			moduleNamed(doc, "Clinic").formsFromMenu?.entryPoints?.map(
				(link) => link.entryPoint.id,
			),
		).toEqual(["clinic_notes"]);
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	});

	it("are refused at their place where the menu listed has no case type", async () => {
		const reading = await readMenusOf(surveysListed());
		expect(codesOf(reading)).toEqual([
			"menus-and-case-lists/mirror-form-deep-links-on-a-menu-listing-survey-forms",
		]);
	});
});
