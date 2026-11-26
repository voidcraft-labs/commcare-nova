import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { type FormCaseSelection, plainColumn, proseText } from "@/lib/domain";
import { formField, term } from "@/lib/domain/expression";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

const id = "targeted-shared-visit-entries";
const uuid = (name: string) => targetedUuid(id, name);

export function sharedVisitsBlueprint(appId: string) {
	const people = uuid("people");
	const visit = uuid("visit");
	const referral = uuid("referral");
	const callback = uuid("callback");
	const choose = (tag: string, name: string): FormCaseSelection => ({
		uuid: uuid(tag),
		tag,
		name,
		caseType: "person",
		source: { kind: "choose", module: people },
	});
	const referred = choose("referrer", "Referring person");
	const patient = choose("patient", "Person receiving care");
	const contact = choose("contact", "Contact person");
	const doc = buildDoc(
		{
			appId,
			appName: "Shared visits",
			caseTypes: [
				{
					name: "person",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{ name: "visit_note", label: proseText("Visit note") },
					],
				},
			],
			modules: [
				{
					uuid: people,
					name: "People",
					caseType: "person",
					caseListConfig: caseListOf([
						plainColumn(uuid("name"), "case_name", "Name"),
					]),
					forms: [
						{
							uuid: visit,
							name: "Visit",
							type: "followup",
							fields: [
								f({
									uuid: uuid("note"),
									kind: "text",
									id: "visit_note",
									label: proseText("Visit note"),
								}),
							],
						},
						{
							uuid: referral,
							name: "Follow a referral",
							type: "followup",
							fields: [],
						},
						{
							uuid: callback,
							name: "Return a call",
							type: "followup",
							fields: [],
						},
					],
				},
				{
					uuid: uuid("messages"),
					name: "Messages",
					forms: [
						{
							uuid: uuid("message"),
							name: "Leave a message",
							type: "survey",
							fields: [
								f({
									uuid: uuid("text"),
									kind: "text",
									id: "text",
									label: proseText("Message"),
								}),
							],
						},
					],
				},
			],
		},
		(d) => {
			d.forms[visit].caseSelections = [referred, patient];
			d.forms[visit].caseOperations = [
				{
					uuid: uuid("save"),
					id: "visit",
					action: "own",
					writes: [
						{ property: "visit_note", value: term(formField(uuid("note"))) },
					],
				},
			];
			const use = (c: FormCaseSelection) => ({
				kind: "replace" as const,
				selection: c.uuid,
				source: c.source,
				caseType: c.caseType,
			});
			d.forms[referral].shadowOf = {
				form: visit,
				selections: [use(patient), { kind: "add", ...contact }, use(referred)],
			};
			d.forms[referral].postSubmit = "firstMenu";
			d.forms[callback].shadowOf = { form: visit, selections: [use(patient)] };
		},
	);
	return doc;
}

export function sharedVisitEntries() {
	const doc = sharedVisitsBlueprint(id);
	const visit = uuid("visit");
	return targetedDocument({
		id,
		rows: [
			"ordered shared entries opening one form with its original record writes",
		],
		doc,
		expected: {
			intent: [
				answerHeld(
					"shared-question-in-parent",
					visit,
					"/data/visit_note",
					"Seen",
					"local",
					{
						command: "m0-f0",
						data: { case_id_referrer: "person-2", case_id_patient: "person-1" },
					},
				),
			],
		},
	});
}
