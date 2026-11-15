import { testUuid } from "@/__tests__/helpers/uuid";
import {
	bindDeclaredWorkerReads,
	buildDoc,
	caseListConfig,
	declareWorkerProperties,
	f,
} from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import {
	advancedSearchInputDef,
	type BlueprintDoc,
	blueprintDocSchema,
	hiddenSearchInputDef,
	NEW_APP_SETTINGS,
	proseText,
	type SearchInputDef,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	and,
	concat,
	count,
	dateAdd,
	dateLiteral,
	double,
	eq,
	gt,
	input,
	isBlank,
	literal,
	matchAll,
	matchesPattern,
	prop,
	sessionUser,
	subcasePath,
	tableColumn,
	tableLookup,
	term,
	whenInput,
	within,
} from "@/lib/domain/expression";
import {
	lookupColumnIdSchema,
	lookupRowIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { parseLookupRevision } from "@/lib/lookup/schema";
import type { LookupTableDefinition } from "@/lib/lookup/types";
import { buildLookupFixtures } from "../lookup/fixtures";
import { lookupWireNaming } from "../lookup/naming";
import { runValidation } from "../validator/runner";
import { searchEmissionFixture } from "./searchEmissionFixture";

export const PROMPT_IDS = Object.fromEntries(
	[
		"first_name",
		"name_query",
		"visit_date",
		"period",
		"barcode",
		"region",
		"regions",
		"hidden",
		"months",
		"minimum",
		"near_home",
		"near_work",
		"last_name",
	].map((name) => [name, testUuid(`prompt-${name}`)]),
);
const tableId = lookupTableIdSchema.parse(
	"018f0000-0000-7000-8000-000000000001",
);
const valueId = lookupColumnIdSchema.parse(
	"018f0000-0000-7000-8000-000000000002",
);
const labelId = lookupColumnIdSchema.parse(
	"018f0000-0000-7000-8000-000000000003",
);
const groupId = lookupColumnIdSchema.parse(
	"018f0000-0000-7000-8000-000000000004",
);
const revision = parseLookupRevision("1");
const definition: LookupTableDefinition = {
	id: tableId,
	name: "Regions",
	tag: "regions",
	definitionRevision: revision,
	columns: [
		{ id: valueId, wireName: "code", label: "Code", dataType: "text" },
		{ id: labelId, wireName: "label", label: "Label", dataType: "text" },
		{ id: groupId, wireName: "group_name", label: "Group", dataType: "text" },
	],
};
export const promptLookupContext: LookupValidationContext = {
	kind: "available",
	projectId: "prompt-evidence",
	projectRevision: revision,
	definitions: [definition],
};
export const promptLookupNaming = lookupWireNaming([definition]);
/** The regions table's rows: `north` and `east` in group `A`, `south` in
 *  `B`. */
export const promptLookupRows = new Map([
	[
		tableId,
		[
			{
				id: lookupRowIdSchema.parse("018f0000-0000-7000-8000-000000000011"),
				values: {
					[valueId]: "north",
					[labelId]: "North & coast",
					[groupId]: "A",
				},
			},
			{
				id: lookupRowIdSchema.parse("018f0000-0000-7000-8000-000000000012"),
				values: { [valueId]: "east", [labelId]: "East", [groupId]: "A" },
			},
			{
				id: lookupRowIdSchema.parse("018f0000-0000-7000-8000-000000000013"),
				values: { [valueId]: "south", [labelId]: "South", [groupId]: "B" },
			},
		],
	],
]);
export const promptLookupFixtures = buildLookupFixtures(
	promptLookupNaming,
	promptLookupRows,
);
export const promptScenarios = [
	"prompt-widgets",
	"prompt-guards",
	"prompt-dataflow",
] as const;
export type PromptScenario = (typeof promptScenarios)[number];
export function searchPromptFixture(scenario: PromptScenario) {
	const doc = searchEmissionFixture("remote");
	const module = doc.modules[doc.moduleOrder[0]];
	const config = module.caseListConfig;
	if (!config || !doc.caseTypes?.[0])
		throw new Error("Fixture has a typed case list");
	doc.caseTypes[0].properties.push(
		{ name: "visit_date", label: proseText("Visit date"), data_type: "date" },
		{ name: "period", label: proseText("Period"), data_type: "date" },
		{ name: "regions", label: proseText("Regions"), data_type: "text" },
		{ name: "barcode", label: proseText("Barcode"), data_type: "text" },
		{ name: "region", label: proseText("Region"), data_type: "text" },
	);
	const id = PROMPT_IDS;
	if (scenario === "prompt-widgets") {
		declareWorkerProperties(doc, ["region_group"]);
		const options = {
			kind: "lookup",
			tableId,
			valueColumnId: valueId,
			labelColumnId: labelId,
			filter: eq(tableColumn(tableId, groupId), sessionUser("region_group")),
		} as const;
		config.searchInputs = [
			simpleSearchInputDef(
				id.first_name,
				"first_name",
				"Name",
				"text",
				"first_name",
				{
					hint: "Use the registered name",
					required: { message: "Add a name" },
				},
			),
			simpleSearchInputDef(
				id.name_query,
				"name_query",
				"Name check",
				"text",
				"first_name",
				{
					required: {
						when: isBlank(input(id.first_name)),
						message: "Add either name",
					},
					validation: {
						rule: matchesPattern(input(id.name_query), "^[A-Z].*$"),
						message: "Start with a capital letter",
					},
				},
			),
			simpleSearchInputDef(
				id.visit_date,
				"visit_date",
				"Visit date",
				"date",
				"visit_date",
				{ default: term(dateLiteral("2026-01-31")) },
			),
			simpleSearchInputDef(
				id.period,
				"period",
				"Visit period",
				"date-range",
				"period",
			),
			simpleSearchInputDef(
				id.barcode,
				"barcode",
				"Scan code",
				"barcode",
				"barcode",
				{ default: term(literal("00123")) },
			),
			simpleSearchInputDef(id.region, "region", "Region", "select", "region", {
				options,
				default: term(literal("north")),
			}),
			simpleSearchInputDef(
				id.regions,
				"regions",
				"Regions",
				"multi-select",
				"regions",
				{ options },
			),
			hiddenSearchInputDef(
				id.hidden,
				"hidden",
				"Hidden value",
				term(literal("secret")),
			),
		];
	} else if (scenario === "prompt-dataflow") {
		doc.caseTypes[0].properties.push(
			{
				name: "home_location",
				label: proseText("Home"),
				data_type: "geopoint",
			},
			{
				name: "work_location",
				label: proseText("Work"),
				data_type: "geopoint",
			},
		);
		const location = (name: "near_home" | "near_work", property: string) =>
			advancedSearchInputDef(
				id[name],
				name,
				name,
				"text",
				whenInput(
					input(id[name]),
					within(prop("patient", property), input(id[name]), 5, "kilometers"),
				),
			);
		config.searchInputs = [
			location("near_home", "home_location"),
			location("near_work", "work_location"),
			advancedSearchInputDef(
				id.first_name,
				"first_name",
				"First name",
				"text",
				matchAll(),
			),
			advancedSearchInputDef(
				id.last_name,
				"last_name",
				"Last name",
				"text",
				matchAll(),
			),
		];
		config.filter = and(
			eq(
				prop("patient", "first_name"),
				tableLookup(
					tableId,
					labelId,
					eq(tableColumn(tableId, valueId), literal("north")),
				),
			),
			whenInput(
				input(id.first_name),
				whenInput(
					input(id.last_name),
					eq(
						prop("patient", "case_name"),
						concat(
							term(input(id.first_name)),
							term(literal(" ")),
							term(input(id.last_name)),
						),
					),
				),
			),
		);
	} else {
		doc.caseTypes.push({
			name: "child",
			parent_type: "patient",
			properties: [
				{ name: "case_name", label: proseText("Name"), data_type: "text" },
			],
		});
		config.searchInputs = [
			advancedSearchInputDef(
				id.months,
				"months",
				"Months",
				"text",
				whenInput(
					input(id.months),
					eq(
						prop("patient", "visit_date"),
						dateAdd(
							term(dateLiteral("2026-01-31")),
							"months",
							double(term(input(id.months))),
						),
					),
				),
			),
			advancedSearchInputDef(
				id.minimum,
				"minimum",
				"Minimum children",
				"text",
				whenInput(
					input(id.minimum),
					gt(
						count(subcasePath("parent", "child")),
						double(term(input(id.minimum))),
					),
				),
			),
			advancedSearchInputDef(
				id.first_name,
				"first_name",
				"Name",
				"text",
				matchAll(),
			),
		];
		config.filter = whenInput(
			input(id.first_name),
			eq(prop("patient", "first_name"), input(id.first_name)),
		);
	}
	// The widgets' single-date and multiple-choice Search fields run in Web
	// Apps alone, and the remote fixture they are added to runs on both.
	if (scenario === "prompt-widgets")
		doc.appSettings = { ...doc.appSettings, runsOnlyOn: "web-apps" };
	// Each declared field is read by its identity, as the gate asks.
	bindDeclaredWorkerReads(doc);
	blueprintDocSchema.parse(toPersistableDoc(doc));
	const findings = runValidation(doc, promptLookupContext);
	if (findings.length) throw new Error(JSON.stringify({ scenario, findings }));
	return doc;
}

/**
 * The worker-place Search document: one remote Search per menu, each reading
 * the worker's primary place from the session
 * (`external-user('commcare_location_id')`) in one slot, which a worker
 * assigned nowhere lacks (`models.py::get_user_session_data` writes the
 * place keys only for a placed worker). The menus, in order:
 *
 * - `starting-value`: a field's starting value reads it;
 * - `hidden-value`: a hidden value reads it;
 * - `required`: a required condition reads it;
 * - `check-answered`: a check reads it, on a field a starting value answers;
 * - `check-unanswered`: the same check, on a field nothing answers;
 * - `choices`: a choice list's filter reads it;
 * - `unoffered-choice`: a check reads it, on a choice field whose starting
 *   value the list does not offer, which Core lets go before it checks
 *   (`RemoteQuerySessionManager.refreshItemSetChoices`), so nothing reads it;
 * - `anyone`: nothing reads it.
 *
 * The app runs on both platforms, so `SearchPromptRuntimeTest` builds each
 * menu's query manager as Formplayer and as Android do.
 */
export const WORKER_PLACE_SEARCH_MENUS = [
	"starting-value",
	"hidden-value",
	"required",
	"check-answered",
	"check-unanswered",
	"choices",
	"unoffered-choice",
	"anyone",
] as const;
export function searchPromptWorkerPlaceFixture(): BlueprintDoc {
	const place = () => sessionUser("commcare_location_id");
	const atNorth = () => eq(place(), literal("north"));
	const check = { rule: atNorth(), message: "Search from your place" };
	const name = (
		menu: string,
		slots: Parameters<typeof simpleSearchInputDef>[5] = {},
	) =>
		simpleSearchInputDef(
			testUuid(`worker-place-${menu}-name`),
			"first_name",
			"Name",
			"text",
			"first_name",
			slots,
		);
	const inputs: Record<
		(typeof WORKER_PLACE_SEARCH_MENUS)[number],
		SearchInputDef[]
	> = {
		"starting-value": [name("starting-value", { default: term(place()) })],
		"hidden-value": [
			name("hidden-value"),
			hiddenSearchInputDef(
				testUuid("worker-place-hidden-value-place"),
				"place",
				"Place",
				term(place()),
			),
		],
		required: [
			name("required", {
				required: { when: atNorth(), message: "Add a name" },
			}),
		],
		"check-answered": [
			name("check-answered", {
				default: term(literal("Ada")),
				validation: check,
			}),
		],
		"check-unanswered": [name("check-unanswered", { validation: check })],
		choices: [
			simpleSearchInputDef(
				testUuid("worker-place-choices-region"),
				"region",
				"Region",
				"select",
				"region",
				{
					options: {
						kind: "lookup",
						tableId,
						valueColumnId: valueId,
						labelColumnId: labelId,
						filter: eq(tableColumn(tableId, valueId), place()),
					},
				},
			),
		],
		/* Two fields: Core repeats its choice pass once for each field the
		 * screen has, and a value it lets go asks for one more pass. */
		"unoffered-choice": [
			name("unoffered-choice"),
			simpleSearchInputDef(
				testUuid("worker-place-unoffered-choice-region"),
				"region",
				"Region",
				"select",
				"region",
				{
					default: term(literal("west")),
					validation: check,
					options: {
						kind: "lookup",
						tableId,
						valueColumnId: valueId,
						labelColumnId: labelId,
					},
				},
			),
		],
		anyone: [name("anyone")],
	};
	const doc = buildDoc({
		appName: "Worker place search",
		appSettings: { ...NEW_APP_SETTINGS },
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "first_name", label: proseText("First name") },
					{ name: "region", label: proseText("Region") },
				],
			},
		],
		modules: WORKER_PLACE_SEARCH_MENUS.map((menu) => ({
			uuid: `worker-place-search-${menu}`,
			name: `Search ${menu}`,
			caseType: "patient",
			caseListConfig: {
				...caseListConfig([{ field: "case_name", header: "Name" }]),
				searchInputs: inputs[menu],
			},
			caseSearchConfig: {},
			forms: [
				{
					name: "Visit",
					type: "followup" as const,
					fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
				},
			],
		})),
	});
	blueprintDocSchema.parse(toPersistableDoc(doc));
	const findings = runValidation(doc, promptLookupContext);
	if (findings.length)
		throw new Error(JSON.stringify({ scenario: "worker-place", findings }));
	return doc;
}
