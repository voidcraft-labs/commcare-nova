import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	advancedSearchInputDef,
	type BlueprintDoc,
	type CaseListConfig,
	calculatedColumn,
	hiddenSearchInputDef,
	proseText,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	ancestorPath,
	eq,
	input,
	literal,
	prop,
	relationStep,
	sessionUser,
	term,
	whenInput,
} from "@/lib/domain/predicate";

const NAME_INPUT = testUuid("00000000-0000-4000-8000-0000000a0001");
const PARENT_COLUMN = testUuid("00000000-0000-4000-8000-0000000a0002");

export function inlineDoc(
	options: {
		readonly caseListOnly?: boolean;
		readonly multiSelect?: boolean;
	} = {},
): BlueprintDoc {
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	config.searchInputs = [nameInput()];
	if (options.multiSelect === true) {
		config.selection = { kind: "multiple", maximum: 100 };
		const parentName = calculatedColumn(
			PARENT_COLUMN,
			"parent name",
			term(
				prop(
					"patient",
					"first_name",
					ancestorPath(relationStep("parent", "patient")),
				),
			),
		);
		config.columns = [...config.columns, parentName];
		config.listColumnOrder = [...config.listColumnOrder, PARENT_COLUMN];
		config.detailColumnOrder = [...config.detailColumnOrder, PARENT_COLUMN];
	}
	return buildDoc({
		appName: "Inline",
		modules: [
			{
				name: "Followup",
				caseType: "patient",
				caseListConfig: config,
				caseSearchConfig: { searchFirst: true },
				...(options.caseListOnly === true
					? { caseListOnly: true }
					: {
							forms: [
								{
									name: "Untitled Form",
									type: "followup",
									fields: [
										f({
											kind: "text",
											id: "question1",
											label: proseText("Question 1"),
										}),
									],
								},
							],
						}),
			},
		],
		caseTypes: [
			{
				name: "patient",
				parent_type: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "first_name", label: proseText("First name") },
				],
			},
		],
	});
}

const FOLLOWUP_MODULE = testUuid("00000000-0000-4000-8000-0000000a0010");
const FOLLOWUP_FORM = testUuid("00000000-0000-4000-8000-0000000a0011");

function nameInput() {
	return simpleSearchInputDef(
		NAME_INPUT,
		"first_name",
		"Name",
		"text",
		"first_name",
	);
}

function question1() {
	return f({ kind: "text", id: "question1", label: proseText("Question 1") });
}

export function registrationLinkDoc(
	options: {
		readonly searchInputs?: CaseListConfig["searchInputs"];
		readonly datums?: Array<{ name: string; xpath: string }>;
	} = {},
): BlueprintDoc {
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	config.searchInputs = options.searchInputs ?? [nameInput()];
	return buildDoc({
		appName: "Inline",
		modules: [
			{
				uuid: FOLLOWUP_MODULE,
				name: "Followup",
				caseType: "patient",
				caseListConfig: config,
				caseSearchConfig: { searchFirst: true },
				forms: [
					{
						uuid: FOLLOWUP_FORM,
						name: "Untitled Form",
						type: "followup",
						fields: [question1()],
					},
				],
			},
			{
				name: "Registration",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Untitled Form",
						type: "registration",
						formLinks: [
							{
								target: {
									type: "form",
									moduleUuid: FOLLOWUP_MODULE,
									formUuid: FOLLOWUP_FORM,
								},
								datums: options.datums,
							},
						],
						fields: [
							f({
								kind: "text",
								id: "question1",
								label: proseText("Question 1"),
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
						],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "first_name", label: proseText("First name") },
				],
			},
		],
	});
}

export function parentSelectDoc(): BlueprintDoc {
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	config.searchInputs = [nameInput()];
	return buildDoc({
		appName: "Inline",
		modules: [
			{
				name: "Followup",
				caseType: "patient",
				caseListConfig: config,
				caseSearchConfig: { searchFirst: true },
				forms: [
					{ name: "Untitled Form", type: "followup", fields: [question1()] },
				],
			},
			{
				name: "Followup2",
				caseType: "parent_case",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{ name: "Untitled Form", type: "followup", fields: [question1()] },
				],
			},
		],
		caseTypes: [
			{
				name: "parent_case",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
			{
				name: "patient",
				parent_type: "parent_case",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "first_name", label: proseText("First name") },
				],
			},
		],
	});
}

export const searchEmissionScenarios = [
	"inline",
	"browse",
	"multiple",
	"parent",
	"registration-link",
	"hidden-link",
	"automatic",
	"hidden",
	"advanced",
	"remote",
	"remote-multiple",
	"remote-defaults",
] as const;
export type SearchEmissionScenario = (typeof searchEmissionScenarios)[number];
export function searchEmissionFixture(
	scenario: SearchEmissionScenario,
): BlueprintDoc {
	if (scenario === "parent") return parentSelectDoc();
	if (scenario === "registration-link") return registrationLinkDoc();
	if (scenario === "hidden-link")
		return registrationLinkDoc({
			searchInputs: [
				hiddenSearchInputDef(
					testUuid("hidden-time"),
					"search_time",
					"Search time",
					term(literal("now")),
				),
			],
			datums: [
				{
					name: "case_id",
					xpath:
						"instance('commcaresession')/session/data/case_id_new_patient_0",
				},
			],
		});
	const doc = inlineDoc({
		caseListOnly: scenario === "browse",
		multiSelect: scenario === "multiple" || scenario === "remote-multiple",
	});
	const module = doc.modules[doc.moduleOrder[0]];
	const config = module.caseListConfig;
	if (!config) throw new Error("Fixture has a case list");
	if (scenario.startsWith("remote")) module.caseSearchConfig = {};
	if (scenario === "automatic") config.searchInputs = [];
	if (scenario === "hidden")
		config.searchInputs = [
			hiddenSearchInputDef(
				testUuid("hidden-time"),
				"search_time",
				"Search time",
				term(literal("now")),
			),
		];
	if (scenario === "advanced") {
		const id = testUuid("note-input");
		config.searchInputs = [
			...config.searchInputs,
			advancedSearchInputDef(
				id,
				"note",
				"Note",
				"text",
				whenInput(input(id), eq(prop("patient", "first_name"), input(id))),
			),
		];
	}
	if (scenario === "remote-defaults") {
		module.caseSearchConfig = {
			searchButtonLabel: "Find patient",
			searchScreenTitle: "Search patients",
			excludedOwnerIds: term(sessionUser("excluded_owners")),
		};
		const primary = {
			...nameInput(),
			default: term(sessionUser("default_name")),
		};
		const echo = {
			...simpleSearchInputDef(
				testUuid("echo"),
				"echo",
				"Echo",
				"text",
				"first_name",
			),
			default: term(sessionUser("default_name")),
		};
		config.searchInputs = [primary, echo];
	}
	return doc;
}
