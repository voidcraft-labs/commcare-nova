import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f, xp } from "@/lib/__tests__/docHelpers";
import {
	wireRow,
	wireTable,
} from "@/lib/commcare/lookup/__tests__/lookupWireCorpus";
import { buildLookupFixtures } from "@/lib/commcare/lookup/fixtures";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import { runValidation } from "@/lib/commcare/validator/runner";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	blueprintDocSchema,
	calculatedColumn,
	plainColumn,
	proseText,
} from "@/lib/domain";
import {
	eq,
	formField,
	literal,
	matchAll,
	prop,
	sessionContext,
	tableColumn,
	tableLookup,
} from "@/lib/domain/predicate";
import { parseLookupRevision } from "@/lib/lookup/schema";

export function lookupAppFixture(reversed = false) {
	const table = wireTable("regions", [
		{ name: "value", type: "text" },
		{ name: "label", type: "text" },
		{ name: "province", type: "text" },
	]);
	const [value, label, province] = table.columns;
	const orderedRows = [
		wireRow(table, "n", { value: "north", label: "Northland", province: "p1" }),
		wireRow(table, "s", { value: "south", label: "Southland", province: "p2" }),
		wireRow(table, "e", { value: "east", label: "Eastland", province: "p1" }),
	];
	const rows = reversed ? [...orderedRows].reverse() : orderedRows;
	const naming = lookupWireNaming([table]);
	const source = {
		kind: "lookup",
		tableId: table.id,
		valueColumnId: value.id,
		labelColumnId: label.id,
	} as const;
	const root = testUuid("lookup-root-province");
	const repeated = testUuid("lookup-repeated-province");
	const cols = [
		plainColumn(testUuid("lookup-case-name"), "case_name", "Name"),
		calculatedColumn(
			testUuid("lookup-case-label"),
			"Region",
			tableLookup(
				table.id,
				label.id,
				eq(tableColumn(table.id, value.id), prop("patient", "region")),
			),
		),
	];
	const doc = buildDoc({
		appName: "Lookup proof",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "region", label: proseText("Region") },
					{ name: "resolved", label: proseText("Resolved") },
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				displayCondition: eq(
					tableLookup(table.id, label.id, matchAll()),
					literal("Northland"),
				),
				caseListConfig: {
					columns: cols,
					listColumnOrder: cols.map((column) => column.uuid),
					detailColumnOrder: cols.map((column) => column.uuid),
					searchInputs: [],
				},
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								uuid: root,
								id: "province",
								label: proseText("Province"),
								default_value: xp("'p1'"),
							}),
							f({
								kind: "single_select",
								id: "all_regions",
								label: proseText("All regions"),
								optionsSource: source,
							}),
							f({
								kind: "single_select",
								id: "filtered",
								label: proseText("Filtered"),
								optionsSource: {
									...source,
									filter: eq(
										tableColumn(table.id, province.id),
										formField(root),
									),
								},
							}),
							f({
								kind: "single_select",
								id: "session_filtered",
								label: proseText("Worker region"),
								optionsSource: {
									...source,
									filter: eq(
										tableColumn(table.id, value.id),
										sessionContext("username"),
									),
								},
							}),
							f({
								kind: "multi_select",
								id: "many",
								label: proseText("Many"),
								optionsSource: source,
							}),
							f({
								kind: "repeat",
								id: "visits",
								label: proseText("Visits"),
								repeat_mode: "count_bound",
								repeat_count: "2",
								children: [
									f({
										kind: "text",
										uuid: repeated,
										id: "zone",
										label: proseText("Zone"),
										default_value: xp("'p1'"),
									}),
									f({
										kind: "single_select",
										id: "repeat_filtered",
										label: proseText("Repeated choice"),
										optionsSource: {
											...source,
											filter: eq(
												tableColumn(table.id, province.id),
												formField(repeated),
											),
										},
									}),
								],
							}),
						],
					},
				],
			},
		],
	});
	doc.forms[doc.formOrder[doc.moduleOrder[0]][0]].caseOperations = [
		{
			uuid: testUuid("lookup-op"),
			id: "resolve_region",
			action: "update",
			caseType: "patient",
			target: { kind: "session" },
			writes: [
				{
					property: "resolved",
					value: tableLookup(
						table.id,
						label.id,
						eq(tableColumn(table.id, value.id), prop("patient", "region")),
					),
				},
			],
		},
	];
	blueprintDocSchema.parse(toPersistableDoc(doc));
	const context = {
		kind: "available",
		projectId: "project-lookup-proof",
		projectRevision: parseLookupRevision("1"),
		definitions: [table],
	} as const;
	const findings = runValidation(doc, context);
	if (findings.length) throw new Error(JSON.stringify(findings));
	const fixtures = buildLookupFixtures(naming, new Map([[table.id, rows]]));
	return { doc, table, rows, naming, fixtures, context };
}
