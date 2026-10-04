/**
 * Fixed witnesses for contracts the harness itself proves. Balanced edit
 * assignment may give a producer another admitted edit when an unrelated
 * document changes; these witnesses keep the precise edit the contract needs.
 * Their identities, D and D′ are written, then planned and gated as every
 * targeted document is.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { plainColumn, proseText } from "@/lib/domain";
import { eq, literal, prop } from "@/lib/domain/predicate";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";
import { answerHeld } from "./echo";

function parentFrame(previous: boolean) {
	const id = previous
		? "targeted-parent-form-previous-frame"
		: "targeted-parent-form-selection-frame";
	const uuid = (name: string) => targetedUuid(id, name);
	const parentCase = "targeted-parent";
	const make = (registration: boolean) => {
		const doc = buildDoc({
			appId: id,
			appName: "Nested care",
			caseTypes: [
				{
					name: "gold-fish",
					properties: [{ name: "care_status", label: proseText("Status") }],
				},
				{
					name: "guppy",
					parent_type: "gold-fish",
					properties: [
						{ name: "care_status", label: proseText("Status") },
						{ name: "case_name", label: proseText("Name") },
					],
				},
			],
			modules: [
				{
					uuid: uuid("parents"),
					name: "Parents",
					caseType: "gold-fish",
					caseListConfig: caseListOf([
						plainColumn(uuid("parent-status"), "care_status", "Status"),
					]),
					forms: [
						{
							uuid: uuid("parent-visit"),
							name: "Parent visit",
							type: "followup",
							fields: [
								f({
									kind: "text",
									uuid: uuid("parent-answer"),
									id: previous ? "child_name" : "parent_note",
									label: proseText(previous ? "Child name" : "Parent note"),
									...(previous && {
										caseWrite: { caseType: "guppy", property: "case_name" },
									}),
								}),
							],
						},
						...(registration
							? [
									{
										uuid: uuid("registration"),
										name: "Registration",
										type: "registration" as const,
										fields: [
											f({
												kind: "text",
												uuid: uuid("case-name"),
												id: "case_name",
												label: proseText("Name"),
												caseWrite: {
													caseType: "gold-fish",
													property: "case_name",
												},
											}),
										],
									},
								]
							: []),
					],
				},
				{
					uuid: uuid("children"),
					name: "Child care",
					caseType: "guppy",
					parentCaseModuleUuid: uuid("parents"),
					caseListConfig: caseListOf(
						[plainColumn(uuid("child-status"), "care_status", "Status")],
						previous
							? {}
							: { filter: eq(prop("guppy", "care_status"), literal("active")) },
					),
					forms: [
						{
							uuid: uuid("child-visit"),
							name: "Child visit",
							type: "followup",
							...(previous && { postSubmit: "previous" as const }),
							displayCondition: eq(
								prop("guppy", "care_status"),
								literal("active"),
							),
							fields: [
								f({
									kind: "hidden",
									uuid: uuid("copied-status"),
									id: "copied_status",
									calculate: "#guppy/care_status",
								}),
							],
						},
					],
				},
			],
		});
		doc.modules[uuid("children")].parentModuleUuid = uuid("parents");
		return doc;
	};
	return targetedDocument({
		id,
		rows: ["proof 5, a parent menu's added form reorders its child's frame"],
		doc: make(false),
		edit: make(true),
		expected: {
			intent: [
				{
					...answerHeld(
						"parent-answer-held",
						uuid("parent-visit"),
						previous ? "/data/child_name" : "/data/parent_note",
						"seen",
					),
					...(previous && {
						restore: "restore.xml",
						request: {
							session: {
								command: "m0-f0",
								data: {
									case_id: parentCase,
									case_id_new_guppy_0: "targeted-new-guppy",
								},
							},
							answers: [{ path: "/data/child_name", value: "seen" }],
							expressions: ["/data/child_name"],
						},
					}),
				},
			],
		},
		...(previous && {
			files: {
				"restore.xml": restoreXml({
					cases: [
						{
							id: parentCase,
							type: "gold-fish",
							name: "Parent",
							properties: { care_status: "active" },
						},
					],
				}),
			},
		}),
	});
}

export function parentFormSelectionFrame() {
	return parentFrame(false);
}

export function parentFormPreviousFrame() {
	return parentFrame(true);
}

/** A Nova-only purpose edit, with a real case-writing form on both sides. */
export function wireEqualRepublish() {
	const id = "targeted-wire-equal-republish";
	const uuid = (name: string) => targetedUuid(id, name);
	const patientCase = "targeted-patient";
	const doc = buildDoc({
		appId: id,
		appName: "Visit notes",
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "note", label: proseText("Note") }],
			},
		],
		modules: [
			{
				uuid: uuid("module"),
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListOf([
					plainColumn(uuid("name"), "case_name", "Name"),
				]),
				forms: [
					{
						uuid: uuid("form"),
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								uuid: uuid("note"),
								id: "note",
								label: proseText("Note"),
								caseWrite: { caseType: "patient", property: "note" },
							}),
						],
					},
				],
			},
		],
	});
	const edit = structuredClone(doc);
	edit.modules[uuid("module")].purpose = "Record a patient's visit note";
	return targetedDocument({
		id,
		rows: ["the B-edit intent observation with B's nonempty inputs"],
		doc,
		edit,
		expected: {
			intent: [
				{
					...answerHeld("note-held", uuid("form"), "/data/note", "seen"),
					restore: "restore.xml",
					request: {
						session: { command: "m0-f0", data: { case_id: patientCase } },
						answers: [{ path: "/data/note", value: "seen" }],
						expressions: ["/data/note"],
					},
				},
			],
		},
		files: {
			"restore.xml": restoreXml({
				cases: [
					{
						id: patientCase,
						type: "patient",
						name: "Patient",
						properties: { note: "earlier" },
					},
				],
			}),
		},
	});
}
