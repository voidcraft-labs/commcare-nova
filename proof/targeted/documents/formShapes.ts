/**
 * Forms whose shape HQ's form builder (Vellum) refuses or rewrites, or whose
 * menu HQ holds otherwise than the document states.
 *
 * - `targeted-survey-menu` (defect 14, survey menus): a menu of the
 *   household case type whose forms are all surveys, so it lists no cases.
 *   Nova publishes its case type as `''`
 *   (`lib/commcare/formLinkProjection.ts::moduleCaseTypeForActions`).
 * - `targeted-invalid-question-ids` (defect 15): question ids with a
 *   leading underscore, a leading `XML` and `Meta`, which Nova's id rule
 *   admits (`lib/commcare/constants.ts::XML_ELEMENT_NAME_REGEX`) and Vellum's
 *   refuses (`Vellum src/util.js::isValidElementName`, `^(?!XML)[a-zA-Z][\w-]*$`;
 *   `src/mugs/baseSpecs.js`, `meta` in any case), and an entry point whose id
 *   is not a fixed point of HQ's `slugify`, which every settings save of its
 *   form refuses under `SESSION_ENDPOINTS` (`views/utils.py::set_session_endpoint`).
 * - `targeted-invalid-connect-ids` (defect 15, Connect): a Connect learn
 *   module and assessment whose ids take the same forms, which Vellum's
 *   question-id rule refuses as well.
 * - `targeted-labelled-group-repeat` (defect 27): a user repeat inside a
 *   labelled group, which Nova writes as a field list
 *   (`lib/commcare/xform/builder.ts`), where Vellum asks for a repeat count.
 * - `targeted-reserved-node-names` (the harness's findings, defect 43, a
 *   question named `instance` or `bind`): questions named `instance`, `bind` and `itext`, names Nova
 *   admits and Vellum's parser looks up by bare name in the whole form
 *   (`Vellum src/parser.js::_getInstances`, `xml.find("instance")`).
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
							f({
								kind: "text",
								uuid: uuid("underscore"),
								id: "_notes",
								label: proseText("Notes"),
							}),
							f({
								kind: "text",
								uuid: uuid("xml"),
								id: "XMLcode",
								label: proseText("Code"),
							}),
							f({
								kind: "text",
								uuid: uuid("meta"),
								id: "Meta",
								label: proseText("Details"),
							}),
						],
					},
				],
			},
		],
	});
	const intake = doc.forms[form];
	if (intake === undefined) throw new Error("No intake form.");
	intake.entryPoint = { uuid: uuid("entry"), id: "intake_" };
	return targetedDocument({
		id,
		rows: ["15"],
		doc,
		expected: {
			intent: [answerHeld("notes-held", form, "/data/_notes", "fine")],
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
								id: "_lesson",
								name: "Hand washing",
								description: "Wash for twenty seconds.",
								time_estimate: 5,
							},
							assessment: { id: "XMLquiz" },
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
	const names = ["instance", "bind", "itext"] as const;
	const doc = buildDoc({
		appId: id,
		appName: "Node names",
		modules: [
			{
				uuid: uuid("module"),
				name: "Names",
				forms: names.map((name) => ({
					uuid: uuid(`form-${name}`),
					name: `Named ${name}`,
					type: "survey" as const,
					fields: [
						f({
							kind: "text",
							uuid: uuid(`field-${name}`),
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
		rows: ["43 (a question named instance or bind)"],
		doc,
		expected: {
			intent: names.map((name) =>
				answerHeld(
					`${name}-held`,
					uuid(`form-${name}`),
					`/data/${name}`,
					"kept",
				),
			),
		},
	});
}
