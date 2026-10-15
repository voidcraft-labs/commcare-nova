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
 * - `targeted-parsererror-node-name` (defect 43, a question named
 *   `parsererror`): one question so named. Vellum loads a form through
 *   jQuery's `parseXML`, which takes any element named `parsererror` for the
 *   browser's own parse failure and throws "Invalid XML", so HQ's form
 *   builder cannot open the form and saves nothing.
 * - `targeted-reserved-question-names` (finding 70): questions named
 *   `registration` and `script`, which Vellum warns about on every save
 *   (`Vellum src/mugs/baseSpecs.js`, `RESERVED_NAMES`), and a root question
 *   named `case` in a registration form, which HQ takes for the form's own
 *   case block (`xform.py::XForm.case_node`), so its build and its form
 *   settings and Case Management pages refuse the form.
 * - `targeted-form-root-read` (finding 71): a Hidden Value that counts the
 *   form's root, a repeat counted by it and a repeat over the root as its
 *   list of ids. Nova's path check reads only paths under `/data/`
 *   (`lib/preview/xpath/dependencies.ts::extractPathRefs`), so it admits
 *   each, and HQ's form builder reports the first two as an unknown question.
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

export function parsererrorNodeName() {
	const id = "targeted-parsererror-node-name";
	const uuid = (name: string) => targetedUuid(id, name);
	const form = uuid("form");
	const doc = buildDoc({
		appId: id,
		appName: "Node name",
		modules: [
			{
				uuid: uuid("module"),
				name: "Names",
				forms: [
					{
						uuid: form,
						name: "Named parsererror",
						type: "survey",
						fields: [
							f({
								kind: "text",
								uuid: uuid("field"),
								id: "parsererror",
								label: proseText("The parsererror"),
							}),
						],
					},
				],
			},
		],
	});
	return targetedDocument({
		id,
		rows: ["43 (a question named parsererror)"],
		doc,
		expected: {
			intent: [
				answerHeld("parsererror-held", form, "/data/parsererror", "kept"),
			],
		},
	});
}

export function reservedQuestionNames() {
	const id = "targeted-reserved-question-names";
	const uuid = (name: string) => targetedUuid(id, name);
	const survey = uuid("survey");
	const doc = buildDoc({
		appId: id,
		appName: "Question names",
		caseTypes: [
			{
				name: "client",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{
						name: "case_reference",
						label: proseText("Case reference"),
						data_type: "text",
					},
				],
			},
		],
		modules: [
			{
				uuid: uuid("survey-module"),
				name: "Notes",
				forms: [
					{
						uuid: survey,
						name: "Notes",
						type: "survey",
						fields: [
							f({
								kind: "text",
								uuid: uuid("registration"),
								id: "registration",
								label: proseText("Registration"),
							}),
							f({
								kind: "text",
								uuid: uuid("script"),
								id: "script",
								label: proseText("Script"),
							}),
							f({
								kind: "text",
								uuid: uuid("notes"),
								id: "notes",
								label: proseText("Notes"),
							}),
						],
					},
				],
			},
			{
				uuid: uuid("client-module"),
				name: "Clients",
				caseType: "client",
				caseListConfig: caseListOf([
					plainColumn(uuid("name"), "case_name", "Name"),
				]),
				forms: [
					{
						uuid: uuid("register"),
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								uuid: uuid("full-name"),
								id: "full_name",
								label: proseText("Full name"),
								caseWrite: { caseType: "client", property: "case_name" },
							}),
							f({
								kind: "text",
								uuid: uuid("case"),
								id: "case",
								label: proseText("Case reference"),
								caseWrite: { caseType: "client", property: "case_reference" },
							}),
						],
					},
				],
			},
		],
	});
	return targetedDocument({
		id,
		rows: ["70"],
		doc,
		expected: {
			intent: [answerHeld("notes-held", survey, "/data/notes", "kept")],
		},
	});
}

export function formRootRead() {
	const id = "targeted-form-root-read";
	const uuid = (name: string) => targetedUuid(id, name);
	const calculated = uuid("calculated");
	const doc = buildDoc({
		appId: id,
		appName: "Form root",
		modules: [
			{
				uuid: uuid("module"),
				name: "Root reads",
				forms: [
					{
						uuid: calculated,
						name: "Calculated",
						type: "survey",
						fields: [
							f({
								kind: "text",
								uuid: uuid("name"),
								id: "name",
								label: proseText("Name"),
							}),
							f({
								kind: "hidden",
								uuid: uuid("total"),
								id: "total",
								calculate: "count(/data)",
							}),
						],
					},
					{
						uuid: uuid("counted"),
						name: "Counted",
						type: "survey",
						fields: [
							f({
								kind: "repeat",
								uuid: uuid("rows"),
								id: "rows",
								label: proseText("Rows"),
								repeat_mode: "count_bound",
								repeat_count: "count(/data)",
								children: [
									f({
										kind: "text",
										uuid: uuid("row"),
										id: "row",
										label: proseText("Row"),
									}),
								],
							}),
						],
					},
					{
						uuid: uuid("queried"),
						name: "Queried",
						type: "survey",
						fields: [
							f({
								kind: "repeat",
								uuid: uuid("items"),
								id: "items",
								label: proseText("Items"),
								repeat_mode: "query_bound",
								data_source: { ids_query: "/data" },
								children: [
									f({
										kind: "text",
										uuid: uuid("item"),
										id: "item",
										label: proseText("Item"),
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
		rows: ["71"],
		doc,
		expected: {
			intent: [answerHeld("name-held", calculated, "/data/name", "kept")],
		},
	});
}
