import { testUuid } from "@/__tests__/helpers/uuid";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import {
	advancedSearchInputDef,
	blueprintDocSchema,
	hiddenSearchInputDef,
	proseText,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	lookupColumnIdSchema,
	lookupRowIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
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
} from "@/lib/domain/predicate";
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
export const promptLookupFixtures = buildLookupFixtures(
	promptLookupNaming,
	new Map([
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
	]),
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
	blueprintDocSchema.parse(toPersistableDoc(doc));
	const findings = runValidation(doc, promptLookupContext);
	if (findings.length) throw new Error(JSON.stringify({ scenario, findings }));
	return doc;
}
