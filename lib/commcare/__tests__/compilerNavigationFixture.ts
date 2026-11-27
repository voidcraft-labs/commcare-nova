import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	advancedSearchInputDef,
	NEW_APP_SETTINGS,
	plainColumn,
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
} from "@/lib/domain/expression";

export const navigationScenarios = [
	"base",
	"conditions",
	"owner",
	"links",
] as const;
export type NavigationScenario = (typeof navigationScenarios)[number];

// The document that produced the retained navigation-base HQ answers. The
// menu ID and form namespaces in those answers pin the original run of the
// fixture counter. Keep its column and question IDs from that run as well.
const RETAINED_NAVIGATION_IDENTITIES = {
	column: "col-0601",
	menu: "mod-0602",
	visit: "frm-0603",
	answer: "fld-0604",
	register: "frm-0605",
	name: "fld-0606",
	external: "fld-0607",
} as const;

export function retainedNavigationFixture() {
	return compilerNavigationFixture("base", RETAINED_NAVIGATION_IDENTITIES);
}

export function compilerNavigationFixture(
	scenario: NavigationScenario,
	identities?: {
		readonly column: string;
		readonly menu: string;
		readonly visit: string;
		readonly answer: string;
		readonly register: string;
		readonly name: string;
		readonly external: string;
	},
) {
	if (scenario === "links") {
		const moduleUuid = testUuid("navigation-module");
		const nextFormUuid = testUuid("navigation-next");
		return buildDoc(
			{
				appName: "Linked forms",
				modules: [
					{
						uuid: moduleUuid,
						name: "Reports",
						forms: [
							{
								name: "Intake",
								type: "survey",
								formLinks: [
									{
										condition: "#user/role = 'supervisor'",
										target: {
											type: "form",
											moduleUuid,
											formUuid: nextFormUuid,
										},
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
			},
			(doc) => {
				// Where Intake goes when its destination does not run.
				const intake = doc.formOrder[moduleUuid]?.[0];
				const form = intake === undefined ? undefined : doc.forms[intake];
				if (form === undefined) throw new Error("The fixture lost Intake.");
				doc.forms[form.uuid] = {
					...form,
					otherwise: { kind: "destination", destination: "module" },
				};
			},
		);
	}
	const columnUuid =
		identities === undefined ? undefined : testUuid(identities.column);
	const config =
		columnUuid === undefined
			? caseListConfig([{ field: "case_name", header: "Name" }])
			: {
					columns: [plainColumn(columnUuid, "case_name", "Name")],
					listColumnOrder: [columnUuid],
					detailColumnOrder: [columnUuid],
					searchInputs: [],
				};
	return buildDoc({
		appName: "Patients & visits <Café>",
		...(scenario === "conditions"
			? { workerProperties: ["role"] }
			: scenario === "owner"
				? { workerProperties: ["excluded_owners"] }
				: {}),
		modules: [
			{
				uuid: identities?.menu,
				name: "Patients",
				caseType: "patient",
				caseListConfig: config,
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
						uuid: identities?.visit,
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
								uuid: identities?.answer,
								kind: "text",
								id: "answer",
								label: proseText("Notes"),
								// The preload the cutover writes in place of the starting
								// value it replaced: the case's own value.
								default_value: "#patient/notes",
								caseWrite: { caseType: "patient", property: "notes" },
							}),
						],
					},
					...(scenario === "conditions"
						? []
						: [
								{
									uuid: identities?.register,
									name: "Register",
									type: "registration" as const,
									fields: [
										f({
											uuid: identities?.name,
											kind: "text",
											id: "name",
											label: proseText("Name"),
											default_value: "'Default name'",
											caseWrite: { caseType: "patient", property: "case_name" },
										}),
										f({
											uuid: identities?.external,
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
		// A single-date Search field runs in Web Apps alone.
		...(scenario !== "legacy"
			? { appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "web-apps" } }
			: {}),
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
