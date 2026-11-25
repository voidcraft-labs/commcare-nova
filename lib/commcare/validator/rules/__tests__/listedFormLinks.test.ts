/**
 * A menu listing another menu's forms holds deep links to single forms only
 * where the menu it lists tracks cases: CommCare HQ's menu settings page
 * cannot save them on a menu listing a survey menu's forms
 * (`basicCaseSlots.ts::listedFormLinksSavable`).
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	ROUTE,
	twoMenus,
} from "@/lib/commcare/__tests__/menuFormRoutesFixture";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import { proseText } from "@/lib/domain/prose";
import { runValidation } from "../../runner";

const SURVEYS = testUuid("listed-surveys");
const LISTING = testUuid("listed-surveys-route");
const NOTES = testUuid("listed-surveys-notes");

/** Surveys, and Clinic listing its one form, with or without its own link. */
function surveysListed(withLink: boolean) {
	const doc = buildDoc({
		modules: [
			{
				uuid: SURVEYS,
				name: "Surveys",
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
		entryPoint: { uuid: testUuid("listed-surveys-link"), id: "clinic" },
		formsFromMenu: {
			menuUuid: SURVEYS,
			...(withLink && {
				entryPoints: [
					{
						formUuid: NOTES,
						entryPoint: {
							uuid: testUuid("listed-surveys-form-link"),
							id: "clinic_notes",
						},
					},
				],
			}),
		},
	};
	doc.moduleOrder.push(LISTING);
	doc.formOrder[LISTING] = [];
	return doc;
}

const linkFindings = (doc: ReturnType<typeof surveysListed>) =>
	runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
		(error) =>
			error.code === "MENU_FORM_SOURCE_INVALID" &&
			error.details?.reason === "survey-form-links",
	);

describe("a listing menu's deep links to single forms", () => {
	it("are refused where the menu it lists tracks no cases, with a way forward", () => {
		const [finding, ...rest] = linkFindings(surveysListed(true));
		expect(rest).toEqual([]);
		if (finding === undefined)
			throw new Error("The listing menu's links were not refused.");
		expect(finding.location.moduleUuid).toBe(LISTING);
		expect(userFacingError(finding)).toBe(
			'CommCare HQ can\'t save "Clinic" while it holds deep links to single forms and "Surveys" tracks no cases. You can give each form its deep link in "Surveys" instead.',
		);
	});

	it("leave the same listing menu alone without them, and a case menu's listing with them", () => {
		expect(linkFindings(surveysListed(false))).toEqual([]);
		const listed = twoMenus();
		expect(listed.modules[ROUTE]?.formsFromMenu?.entryPoints).not.toEqual(
			undefined,
		);
		expect(linkFindings(listed)).toEqual([]);
	});
});
