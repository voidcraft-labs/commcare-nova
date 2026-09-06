import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	advancedSearchInputDef,
	proseText,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	dateAdd,
	datetimeCoerce,
	eq,
	input,
	literal,
	prop,
	sessionUser,
	term,
	whenInput,
} from "@/lib/domain/predicate";

export const navigationScenarios = [
	"base",
	"conditions",
	"owner",
	"links",
] as const;
export type NavigationScenario = (typeof navigationScenarios)[number];
export function compilerNavigationFixture(scenario: NavigationScenario) {
	if (scenario === "links") {
		const moduleUuid = testUuid("navigation-module");
		const nextFormUuid = testUuid("navigation-next");
		return buildDoc({
			appName: "Linked forms",
			modules: [
				{
					uuid: moduleUuid,
					name: "Reports",
					forms: [
						{
							name: "Intake",
							type: "survey",
							postSubmit: "module",
							formLinks: [
								{
									condition: "#user/role = 'supervisor'",
									target: { type: "form", moduleUuid, formUuid: nextFormUuid },
								},
							],
							fields: [
								f({ kind: "text", id: "answer", label: proseText("Answer") }),
							],
						},
						{
							uuid: nextFormUuid,
							name: "Review",
							type: "survey",
							fields: [
								f({ kind: "text", id: "notes", label: proseText("Notes") }),
							],
						},
					],
				},
			],
		});
	}
	return buildDoc({
		appName: "Patients & visits <Café>",
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				...(scenario === "conditions"
					? { displayCondition: eq(sessionUser("role"), literal("supervisor")) }
					: {}),
				...(scenario === "owner"
					? {
							caseSearchConfig: {
								searchActionEnabled: false,
								excludedOwnerIds: term(sessionUser("excluded_owners")),
							},
						}
					: {}),
				forms: [
					{
						name: "Visit",
						type: "followup",
						...(scenario === "conditions"
							? {
									displayCondition: eq(
										prop("patient", "status"),
										literal("open"),
									),
								}
							: {}),
						fields: [
							f({
								kind: "text",
								id: "answer",
								label: proseText("Notes"),
								default_value: "'manual-default'",
								caseWrite: { caseType: "patient", property: "notes" },
							}),
						],
					},
					...(scenario === "conditions"
						? []
						: [
								{
									name: "Register",
									type: "registration" as const,
									fields: [
										f({
											kind: "text",
											id: "name",
											label: proseText("Name"),
											default_value: "'Default name'",
											caseWrite: { caseType: "patient", property: "case_name" },
										}),
										f({
											kind: "text",
											id: "external",
											label: proseText("External ID"),
											default_value: "'  Ext-1  '",
											caseWrite: {
												caseType: "patient",
												property: "external_id",
											},
										}),
									],
								},
							]),
				],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name"), data_type: "text" },
					{ name: "notes", label: proseText("Notes"), data_type: "text" },
				],
			},
		],
	});
}

export const temporalSearchScenarios = [
	"legacy",
	"date-add",
	"datetime-add",
	"day-range",
] as const;
export type TemporalSearchScenario = (typeof temporalSearchScenarios)[number];
export function temporalSearchFixture(scenario: TemporalSearchScenario) {
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	const uuid = testUuid("search-date-input");
	if (scenario === "legacy")
		config.searchInputs = [
			simpleSearchInputDef(uuid, "case_name", "Name", "text", "case_name"),
		];
	else if (scenario === "day-range")
		config.searchInputs = ["visit_date", "last_seen", "date_opened"].map(
			(name) =>
				simpleSearchInputDef(
					testUuid(`search-${name}`),
					name,
					name,
					"date",
					name,
				),
		);
	else
		config.searchInputs = [
			advancedSearchInputDef(
				uuid,
				"base_date",
				"Starting date",
				"date",
				whenInput(
					input(uuid),
					eq(
						prop(
							"patient",
							scenario === "date-add" ? "visit_date" : "last_seen",
						),
						scenario === "date-add"
							? dateAdd(term(input(uuid)), "days", term(literal(7)))
							: dateAdd(
									datetimeCoerce(term(input(uuid))),
									"hours",
									term(literal(1)),
								),
					),
				),
			),
		];
	return buildDoc({
		appName: `Search ${scenario}`,
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: config,
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "answer",
								label: proseText("Notes"),
								caseWrite: { caseType: "patient", property: "notes" },
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
					{ name: "case_name", label: proseText("Name"), data_type: "text" },
					{ name: "notes", label: proseText("Notes"), data_type: "text" },
					{
						name: "visit_date",
						label: proseText("Visit date"),
						data_type: "date",
					},
					{
						name: "last_seen",
						label: proseText("Last seen"),
						data_type: "datetime",
					},
				],
			},
		],
	});
}
