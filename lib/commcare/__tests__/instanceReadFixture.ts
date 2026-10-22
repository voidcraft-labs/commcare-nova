/**
 * One app whose form logic, Connect block and after-submit links read every
 * secondary instance a form can read: a data table (first matching row, rows
 * and a column), places, the cases chosen in a several-case module, what a
 * search-first module's search found, a question's own translated text and a
 * choice's label.
 *
 * Each read is stored as the typed tree the parser binds, so the emitters'
 * declarations are observed without the parser or the checker in between.
 */

import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	wireRow,
	wireTable,
} from "@/lib/commcare/lookup/__tests__/lookupWireCorpus";
import { buildLookupFixtures } from "@/lib/commcare/lookup/fixtures";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import { proseText, simpleSearchInputDef } from "@/lib/domain";
import {
	count,
	eq,
	gt,
	literal,
	tableColumn,
	tableLookup,
	term,
} from "@/lib/domain/expression";
import type { Expression } from "@/lib/domain/expression/types";
import { LOCATION_LEVELS } from "../locations/__tests__/locationOwnerFixture";

export const INSTANCE_READS = {
	visitModule: testUuid("instance-reads-visits"),
	visitForm: testUuid("instance-reads-visit"),
	noteForm: testUuid("instance-reads-note"),
	color: testUuid("instance-reads-color"),
	red: testUuid("instance-reads-red"),
	blue: testUuid("instance-reads-blue"),
	batchModule: testUuid("instance-reads-batch"),
	batchForm: testUuid("instance-reads-batch-form"),
	searchModule: testUuid("instance-reads-search"),
	searchForm: testUuid("instance-reads-check-in"),
	searchNote: testUuid("instance-reads-search-note"),
	tableLink: testUuid("instance-reads-table-link"),
	placeLink: testUuid("instance-reads-place-link"),
	resultsLink: testUuid("instance-reads-results-link"),
} as const;

const clinic = LOCATION_LEVELS[2];
const district = LOCATION_LEVELS[1];

/** `instance('locations')/locations/location[@type = 'clinic']/name` */
export function clinicNames(): Expression {
	return {
		kind: "project",
		of: {
			kind: "locations",
			where: [
				eq(
					term({ kind: "location-field", field: "type" }),
					term({ kind: "location-level", levelUuid: clinic.uuid }),
				),
			],
		},
		value: { kind: "location-field", field: "name" },
	};
}

/** `count(instance('results:inline')/results/case[not(commcare_is_related_case = true())])` */
export function searchFound(): Expression {
	return count({ kind: "cases", source: "search-results", where: [] });
}

export function instanceReadFixture() {
	const table = wireTable("regions", [
		{ name: "value", type: "text" },
		{ name: "label", type: "text" },
	]);
	const [value, label] = table.columns;
	const rows = [
		wireRow(table, "n", { value: "north", label: "Northland" }),
		wireRow(table, "s", { value: "south", label: "Southland" }),
	];
	const naming = lookupWireNaming([table]);
	const regionRows: Expression = {
		kind: "table-rows",
		tableId: table.id,
		where: [],
	};
	const hidden = (id: string, calculate: Expression) =>
		f({ kind: "hidden", id, calculate });
	const doc = buildDoc({
		appName: "Instance reads",
		connectType: "deliver",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "district", label: proseText("District") },
				],
			},
		],
		modules: [
			{
				uuid: INSTANCE_READS.visitModule,
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: INSTANCE_READS.visitForm,
						name: "Visit",
						type: "followup",
						postSubmit: "module",
						connect: {
							deliver_unit: {
								id: "visit",
								name: "Visit",
								entity_name: tableLookup(
									table.id,
									label.id,
									eq(tableColumn(table.id, value.id), literal("south")),
								),
							},
						},
						fields: [
							f({
								kind: "single_select",
								uuid: INSTANCE_READS.color,
								id: "color",
								label: proseText("Color"),
								optionsSource: {
									kind: "inline",
									options: [
										{
											uuid: INSTANCE_READS.red,
											value: "red",
											label: proseText("Red"),
										},
										{
											uuid: INSTANCE_READS.blue,
											value: "blue",
											label: proseText("Blue"),
										},
									],
								},
							}),
							hidden(
								"region_label",
								tableLookup(
									table.id,
									label.id,
									eq(tableColumn(table.id, value.id), literal("north")),
								),
							),
							hidden("region_count", count(regionRows)),
							hidden("region_labels", {
								kind: "call",
								fn: "join",
								args: [
									term(literal(" ")),
									{
										kind: "project",
										of: regionRows,
										value: tableColumn(table.id, label.id),
									},
								],
							}),
							hidden("clinic_name", clinicNames()),
							hidden("district_of_clinics", {
								kind: "project",
								of: { kind: "locations", where: [] },
								value: {
									kind: "location-field",
									field: { level: district.uuid },
								},
							}),
							hidden("color_label", {
								kind: "choice-name",
								field: INSTANCE_READS.color,
								value: term({ kind: "field", uuid: INSTANCE_READS.color }),
							}),
							hidden("color_text", {
								kind: "itext",
								unit: { field: INSTANCE_READS.color, role: "field-label" },
							}),
						],
						formLinks: [
							{
								uuid: INSTANCE_READS.tableLink,
								condition: gt(count(regionRows), term(literal(0))),
								target: {
									type: "form",
									moduleUuid: INSTANCE_READS.visitModule,
									formUuid: INSTANCE_READS.noteForm,
								},
							},
							{
								uuid: INSTANCE_READS.placeLink,
								condition: eq(clinicNames(), term(literal("Central"))),
								target: {
									type: "form",
									moduleUuid: INSTANCE_READS.visitModule,
									formUuid: INSTANCE_READS.noteForm,
								},
							},
						],
					},
					{
						uuid: INSTANCE_READS.noteForm,
						name: "Note",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					},
				],
			},
			{
				uuid: INSTANCE_READS.batchModule,
				name: "Batch",
				caseType: "patient",
				caseListConfig: {
					...caseListConfig([{ field: "case_name", header: "Name" }]),
					selection: { kind: "multiple", maximum: 10 },
				},
				forms: [
					{
						uuid: INSTANCE_READS.batchForm,
						name: "Batch note",
						type: "followup",
						fields: [
							hidden(
								"chosen",
								count({
									kind: "selected-cases",
									module: INSTANCE_READS.batchModule,
								}),
							),
						],
					},
				],
			},
			{
				uuid: INSTANCE_READS.searchModule,
				name: "Find patient",
				caseType: "patient",
				caseListConfig: {
					...caseListConfig([{ field: "case_name", header: "Name" }]),
					searchInputs: [
						simpleSearchInputDef(
							testUuid("instance-reads-district"),
							"district",
							"District",
							"text",
							"district",
						),
					],
				},
				caseSearchConfig: { searchFirst: true },
				forms: [
					{
						uuid: INSTANCE_READS.searchForm,
						name: "Check in",
						type: "followup",
						postSubmit: "module",
						fields: [hidden("found", searchFound())],
						formLinks: [
							{
								uuid: INSTANCE_READS.resultsLink,
								condition: gt(searchFound(), term(literal(1))),
								target: {
									type: "form",
									moduleUuid: INSTANCE_READS.searchModule,
									formUuid: INSTANCE_READS.searchNote,
								},
							},
						],
					},
					{
						uuid: INSTANCE_READS.searchNote,
						name: "Search note",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					},
				],
			},
		],
	});
	doc.organizationLevels = Object.fromEntries(
		LOCATION_LEVELS.map((level) => [level.uuid, level]),
	);
	doc.organizationLevelOrder = LOCATION_LEVELS.map((level) => level.uuid);
	rebuildFieldParent(doc);
	const fixtures = buildLookupFixtures(naming, new Map([[table.id, rows]]));
	return { doc, table, rows, naming, fixtures };
}
