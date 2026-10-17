/**
 * Forms whose shape HQ's form builder (Vellum) refuses or rewrites, or whose
 * menu HQ holds otherwise than the document states.
 *
 * - `targeted-survey-menu` (defect 14, survey menus): a menu of the
 *   household case type whose forms are all surveys, so it lists no cases.
 *   Nova publishes its case type as `''`
 *   (`lib/commcare/formLinkProjection.ts::moduleCaseTypeForActions`). It
 *   shows incomplete forms and not saved forms (defect 7 and finding 62),
 *   the document the Web Apps client's Incomplete Forms tile is read on
 *   (`proof/webapps/test_app_list.py`); `targeted-attribute-display-condition`
 *   holds the two the other way round.
 * - `targeted-invalid-question-ids` (defect 15): what the cutover's renames
 *   and Nova's minters write in place of the question and deep link ids HQ's
 *   editors refuse, beside the other replacements the grammar must admit:
 *   `notes`, `q1st`, `qXMLcode` and `q_Meta` (Vellum refuses a leading
 *   underscore, a leading digit, a leading `XML` and `meta` in any case,
 *   `Vellum src/util.js::isValidElementName`, `src/mugs/baseSpecs.js`), a
 *   root group `q_meta` whose question a calculation reads (HQ's build
 *   removes a root node named `meta`, `xform.py::XForm.already_has_meta`),
 *   `q_instance`, `q_bind` and `q_parsererror` (finding 43), a calculation
 *   and a display condition that are `false()`, and the deep links `intake`
 *   and `intake-2_b`, each a fixed point of HQ's `slugify`
 *   (`views/utils.py::get_cleaned_session_endpoint_id`). Its control keeps
 *   the ids HQ's editors refuse.
 * - `targeted-invalid-connect-ids` (defect 15, Connect): a Connect learn
 *   app whose module id is 50 characters starting `q1st_lesson`, what the
 *   cutover makes of one starting `_1st_lesson`, and whose assessment is
 *   `qXMLquiz`. Its control keeps the ids Vellum refuses.
 * - `targeted-labelled-group-repeat` (defect 27): a user repeat inside a
 *   labelled group, which Nova writes as a field list
 *   (`lib/commcare/xform/builder.ts`), where Vellum asks for a repeat count.
 * - `targeted-reserved-node-names` (finding 43): one form for each of the
 *   questions `q_instance`, `q_bind` and `q_parsererror`, the names Nova
 *   offers for the three it refuses, and `itext` and `label`, XForm markup
 *   names Nova admits. Vellum's parser looks names up by bare element name
 *   in the whole form (`Vellum src/parser.js::_getInstances`,
 *   `xml.find("instance")`), and opens every one of these. Its control keeps
 *   the questions named `instance` and `bind`, and
 *   `targeted-parsererror-node-name`'s the one named `parsererror`.
 *
 * Fixed values: each form holds what the worker answers (`./echo.ts`).
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { plainColumn, proseText } from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

export function surveyMenu() {
	const id = "targeted-survey-menu";
	const uuid = (name: string) => targetedUuid(id, name);
	const form = uuid("census");
	const doc = buildDoc({
		appId: id,
		appName: "Household surveys",
		// The witness of the Web Apps client's Incomplete Forms tile: saved
		// forms off and incomplete forms on, the two settings never equal.
		appSettings: { showSavedForms: false, showIncompleteForms: true },
		caseTypes: [
			{
				name: "household",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
		modules: [
			{
				uuid: uuid("module"),
				name: "Household surveys",
				caseType: "household",
				caseListConfig: caseListOf([
					plainColumn(uuid("name"), "case_name", "Name"),
				]),
				forms: [
					{
						uuid: form,
						name: "Census",
						type: "survey",
						fields: [
							f({
								kind: "text",
								uuid: uuid("head"),
								id: "head",
								label: proseText("Head of household"),
							}),
						],
					},
					{
						uuid: uuid("water"),
						name: "Water",
						type: "survey",
						fields: [
							f({
								kind: "text",
								uuid: uuid("source"),
								id: "source",
								label: proseText("Water source"),
							}),
						],
					},
				],
			},
		],
	});
	return targetedDocument({
		id,
		rows: ["14, survey menus"],
		doc,
		expected: {
			intent: [answerHeld("head-held", form, "/data/head", "Achieng", "A")],
		},
	});
}

export function invalidQuestionIds() {
	const id = "targeted-invalid-question-ids";
	const uuid = (name: string) => targetedUuid(id, name);
	const form = uuid("form");
	const second = uuid("second-form");
	const text = (name: string, fieldId: string, label: string) =>
		f({ kind: "text", uuid: uuid(name), id: fieldId, label: proseText(label) });
	const doc = buildDoc({
		appId: id,
		appName: "Question ids",
		modules: [
			{
				uuid: uuid("module"),
				name: "Intake",
				forms: [
					{
						uuid: form,
						name: "Intake",
						type: "survey",
						fields: [
							text("underscore", "notes", "Notes"),
							text("first", "q1st", "First visit"),
							text("xml", "qXMLcode", "Code"),
							text("meta", "q_Meta", "Details"),
							f({
								kind: "group",
								uuid: uuid("meta-group"),
								id: "q_meta",
								label: proseText("More details"),
								children: [text("detail", "detail", "Detail")],
							}),
							f({
								kind: "hidden",
								uuid: uuid("detail-copy"),
								id: "detail_copy",
								calculate: "#form/q_meta/detail",
							}),
							text("instance", "q_instance", "Instance"),
							text("bind", "q_bind", "Bind"),
							text("parsererror", "q_parsererror", "Parser error"),
							f({
								kind: "hidden",
								uuid: uuid("never-value"),
								id: "never_value",
								calculate: "false()",
							}),
							f({
								kind: "text",
								uuid: uuid("never-shown"),
								id: "never_shown",
								label: proseText("Never shown"),
								relevant: "false()",
							}),
						],
					},
					{
						uuid: second,
						name: "Second intake",
						type: "survey",
						fields: [text("second", "second", "Second")],
					},
				],
			},
		],
	});
	const intake = doc.forms[form];
	const secondIntake = doc.forms[second];
	if (intake === undefined || secondIntake === undefined)
		throw new Error("No intake forms.");
	intake.entryPoint = { uuid: uuid("entry"), id: "intake" };
	secondIntake.entryPoint = { uuid: uuid("second-entry"), id: "intake-2_b" };
	return targetedDocument({
		id,
		rows: ["15"],
		doc,
		expected: {
			intent: [answerHeld("notes-held", form, "/data/notes", "fine")],
		},
	});
}

export function invalidConnectIds() {
	const id = "targeted-invalid-connect-ids";
	const uuid = (name: string) => targetedUuid(id, name);
	const form = uuid("form");
	const doc = buildDoc({
		appId: id,
		appName: "Connect ids",
		connectType: "learn",
		modules: [
			{
				uuid: uuid("module"),
				name: "Learning",
				forms: [
					{
						uuid: form,
						name: "Lesson",
						type: "survey",
						connect: {
							learn_module: {
								// What the cutover makes of a 50-character id that starts `_1st_lesson`.
								id: "q1st_lesson".padEnd(50, "x"),
								name: "Hand washing",
								description: "Wash for twenty seconds.",
								time_estimate: 5,
							},
							assessment: { id: "qXMLquiz" },
						},
						fields: [
							f({
								kind: "int",
								uuid: uuid("score"),
								id: "score",
								label: proseText("Score"),
							}),
						],
					},
				],
			},
		],
	});
	return targetedDocument({
		id,
		rows: ["15, Connect ids"],
		doc,
		expected: {
			intent: [answerHeld("score-held", form, "/data/score", "8")],
		},
	});
}

export function labelledGroupRepeat() {
	const id = "targeted-labelled-group-repeat";
	const uuid = (name: string) => targetedUuid(id, name);
	const form = uuid("form");
	const doc = buildDoc({
		appId: id,
		appName: "Household members",
		modules: [
			{
				uuid: uuid("module"),
				name: "Households",
				forms: [
					{
						uuid: form,
						name: "Members",
						type: "survey",
						fields: [
							f({
								kind: "group",
								uuid: uuid("household"),
								id: "household",
								label: proseText("Household"),
								children: [
									f({
										kind: "text",
										uuid: uuid("address"),
										id: "address",
										label: proseText("Address"),
									}),
									f({
										kind: "repeat",
										uuid: uuid("members"),
										id: "members",
										label: proseText("Members"),
										repeat_mode: "user_controlled",
										children: [
											f({
												kind: "text",
												uuid: uuid("member"),
												id: "member",
												label: proseText("Name"),
											}),
										],
									}),
								],
							}),
						],
					},
				],
			},
		],
	});
	return targetedDocument({
		id,
		rows: ["27"],
		doc,
		expected: {
			intent: [
				answerHeld("address-held", form, "/data/household/address", "Plot 7"),
			],
		},
	});
}

export function reservedNodeNames() {
	const id = "targeted-reserved-node-names";
	const uuid = (name: string) => targetedUuid(id, name);
	// Each form keeps the named uuids it had when its question was named for
	// the key: `q_instance` the form of `instance`, `q_bind` the form of `bind`.
	const names = [
		{ key: "instance", name: "q_instance" },
		{ key: "bind", name: "q_bind" },
		{ key: "itext", name: "itext" },
		{ key: "parsererror", name: "q_parsererror" },
		{ key: "label", name: "label" },
	] as const;
	const doc = buildDoc({
		appId: id,
		appName: "Node names",
		modules: [
			{
				uuid: uuid("module"),
				name: "Names",
				forms: names.map(({ key, name }) => ({
					uuid: uuid(`form-${key}`),
					name: `Named ${name}`,
					type: "survey" as const,
					fields: [
						f({
							kind: "text",
							uuid: uuid(`field-${key}`),
							id: name,
							label: proseText(`The ${name}`),
						}),
					],
				})),
			},
		],
	});
	return targetedDocument({
		id,
		rows: [
			"43 (the names offered for instance, bind and parsererror, beside itext and label)",
		],
		doc,
		expected: {
			intent: names.map(({ key, name }) =>
				answerHeld(
					`${name}-held`,
					uuid(`form-${key}`),
					`/data/${name}`,
					"kept",
				),
			),
		},
	});
}
