import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { plainColumn, proseText } from "@/lib/domain";
import { targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

const ID = "targeted-listed-forms";
const uuid = (name: string) => targetedUuid(ID, name);

function survey(id: string, title: string) {
	return {
		uuid: uuid(id),
		name: title,
		type: "survey" as const,
		fields: [
			f({
				kind: "text",
				uuid: uuid(`${id}-note`),
				id: "note",
				label: proseText("Note"),
			}),
		],
	};
}

/** Each endpoint chooses one of two menu routes to the same physical form. One
 * hidden source form distinguishes their Web Apps display-condition contracts. */
export function listedForms() {
	const source = uuid("source");
	const clinic = uuid("clinic");
	const visit = uuid("visit");
	const hidden = uuid("hidden");
	const doc = buildDoc({
		appId: ID,
		appName: "Field visits",
		caseTypes: [{ name: "site", properties: [] }],
		modules: [
			{
				/* A menu that tracks cases: CommCare HQ's menu settings page
				 * can save deep links to single forms only on a menu listing
				 * such a menu's forms (`basicCaseSlots.ts::listedFormLinksSavable`). */
				uuid: source,
				name: "Visits",
				caseType: "site",
				caseListConfig: {
					columns: [plainColumn(uuid("visits-name"), "case_name", "Name")],
					searchInputs: [],
				},
				forms: [
					survey("archive", "Archive"),
					survey("visit", "Visit notes"),
					survey("check", "Check supplies"),
					survey("hidden", "Private notes"),
					{
						uuid: uuid("register"),
						name: "Register a site",
						type: "registration" as const,
						fields: [
							f({
								kind: "text",
								uuid: uuid("register-name"),
								id: "case_name",
								label: proseText("Site name"),
								caseWrite: { caseType: "site", property: "case_name" },
							}),
						],
					},
				],
			},
			{
				uuid: clinic,
				name: "Clinic",
				caseListConfig: {
					columns: [plainColumn(uuid("clinic-name"), "case_name", "Name")],
					searchInputs: [],
				},
				forms: [],
			},
		],
	});
	doc.forms[visit].entryPoint = { uuid: uuid("visit-link"), id: "visit" };
	doc.forms[hidden].hiddenFromMenu = true;
	doc.forms[hidden].entryPoint = {
		uuid: uuid("private-link"),
		id: "private_notes",
		ignoreDisplayConditions: true,
	};
	doc.modules[clinic].entryPoint = {
		uuid: uuid("clinic-menu-link"),
		id: "clinic",
	};
	doc.modules[clinic].formsFromMenu = {
		menuUuid: source,
		excludedFormUuids: [uuid("archive")],
		entryPoints: [
			{
				formUuid: visit,
				entryPoint: { uuid: uuid("clinic-link"), id: "clinic_visit" },
			},
			{
				formUuid: hidden,
				entryPoint: { uuid: uuid("clinic-private-link"), id: "clinic_private" },
			},
		],
	};
	const edit = structuredClone(doc);
	edit.forms[visit].name = "Updated visit notes";
	const note = edit.fields[uuid("visit-note")];
	if (note.kind !== "text")
		throw new Error("The visit note in this document is a text field.");
	note.label = proseText("What happened?");
	return targetedDocument({
		id: ID,
		rows: [
			"One form through two menus and each menu's independent entry points",
		],
		doc,
		edit,
		expected: {
			intent: [
				answerHeld(
					"original-path",
					visit,
					"/data/note",
					"Consultation",
					"local",
					{ command: "m0-f1" },
				),
				answerHeld(
					"clinic-path",
					visit,
					"/data/note",
					"Consultation",
					"local",
					{ command: "m1-f1" },
				),
			],
		},
	});
}
