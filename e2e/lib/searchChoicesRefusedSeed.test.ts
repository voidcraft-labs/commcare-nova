import { describe, expect, it } from "vitest";
import { runValidation } from "@/lib/commcare/validator/runner";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import { blueprintDocSchema, moduleSearchWorkflow } from "@/lib/domain";
import {
	lookupColumnIdSchema,
	lookupRowIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { parseLookupRevision } from "@/lib/lookup/schema";
import {
	previewDataRefusalOf,
	readPreviewScreen,
} from "@/lib/preview/engine/dataRefusal";
import { previewLookupData } from "@/lib/preview/engine/lookupEvaluation";
import {
	openSearchRunState,
	searchScreenOpeningCovered,
} from "@/lib/preview/engine/searchRunState";
import {
	buildSearchChoicesRefusedBlueprint,
	SEARCH_CHOICES_REFUSED_SEED,
} from "./searchChoicesRefusedSeed";

const APP_ID = "5f3c1d2e-8a4b-4c6d-9e0f-1a2b3c4d5e6f";
const table = {
	tableId: lookupTableIdSchema.parse("018f0000-0000-7000-8000-0000000000a1"),
	valueColumnId: lookupColumnIdSchema.parse(
		"018f0000-0000-7000-8000-0000000000a2",
	),
	labelColumnId: lookupColumnIdSchema.parse(
		"018f0000-0000-7000-8000-0000000000a3",
	),
};
const districts = {
	tableId: lookupTableIdSchema.parse("018f0000-0000-7000-8000-0000000000b1"),
	valueColumnId: lookupColumnIdSchema.parse(
		"018f0000-0000-7000-8000-0000000000b2",
	),
	labelColumnId: lookupColumnIdSchema.parse(
		"018f0000-0000-7000-8000-0000000000b3",
	),
};
const revision = parseLookupRevision("1");
const definitions = [
	{
		id: table.tableId,
		name: SEARCH_CHOICES_REFUSED_SEED.table.name,
		tag: SEARCH_CHOICES_REFUSED_SEED.table.tag,
		definitionRevision: revision,
		columns: [
			{
				id: table.valueColumnId,
				wireName: "code",
				label: "Code",
				dataType: "text" as const,
			},
			{
				id: table.labelColumnId,
				wireName: "name",
				label: "Name",
				dataType: "text" as const,
			},
		],
	},
	{
		id: districts.tableId,
		name: SEARCH_CHOICES_REFUSED_SEED.visits.table.name,
		tag: SEARCH_CHOICES_REFUSED_SEED.visits.table.tag,
		definitionRevision: revision,
		columns: [
			{
				id: districts.valueColumnId,
				wireName: "code",
				label: "Code",
				dataType: "text" as const,
			},
			{
				id: districts.labelColumnId,
				wireName: "name",
				label: "Name",
				dataType: "text" as const,
			},
		],
	},
];
const context: LookupValidationContext = {
	kind: "available",
	projectId: "search-choices-refused",
	projectRevision: revision,
	definitions,
};

describe("the search-choices-refused smoke seed", () => {
	const doc = buildSearchChoicesRefusedBlueprint(APP_ID, table, districts);
	const seed = SEARCH_CHOICES_REFUSED_SEED;

	it("is a persistable app with no validator findings, opening on its results", () => {
		const persistable = toPersistableDoc(doc);
		expect(blueprintDocSchema.parse(persistable)).toEqual(persistable);
		expect(runValidation(doc, context)).toEqual([]);
		for (const moduleUuid of [seed.moduleUuid, seed.visits.moduleUuid]) {
			const module = doc.modules[moduleUuid];
			expect(module && moduleSearchWorkflow(module)).toBe("skipToResults");
		}
	});

	it("opens a Home visits Search screen Preview refuses, its one field starting on a district the table does not offer", () => {
		const visits = seed.visits;
		const inputs = doc.modules[visits.moduleUuid]?.caseListConfig?.searchInputs;
		if (inputs === undefined) throw new Error("Home visits has a Search.");
		const lookup = previewLookupData({
			projectRevision: "1",
			definitions,
			rowsByTable: new Map([
				[table.tableId, []],
				[
					districts.tableId,
					visits.table.rows.map((row, index) => ({
						id: lookupRowIdSchema.parse(
							`018f0000-0000-7000-8000-0000000000c${index}`,
						),
						values: {
							[districts.valueColumnId]: row.code,
							[districts.labelColumnId]: row.name,
						},
					})),
				],
			]),
		});
		const environment = { doc, moduleUuid: visits.moduleUuid, lookup };
		const read = readPreviewScreen(() =>
			openSearchRunState(
				visits.moduleUuid,
				inputs,
				{
					context: { userid: "worker", username: "worker" },
					user: {},
					userPropertySlugs: {},
				},
				environment,
			),
		);
		expect(read.kind).toBe("refused");
		if (read.kind === "refused")
			expect(previewDataRefusalOf(read.refusal)?.reason).toEqual({
				kind: "unoffered-starting-choice",
				inputUuid: visits.searchInputUuid,
				input: visits.prompt.label,
			});
	});

	it("opens a Search screen Preview refuses over the empty table, as Core's query manager does", () => {
		const inputs = doc.modules[seed.moduleUuid]?.caseListConfig?.searchInputs;
		if (inputs === undefined) throw new Error("The menu has a Search.");
		const lookup = previewLookupData({
			projectRevision: "1",
			definitions,
			rowsByTable: new Map([[table.tableId, []]]),
		});
		const environment = { doc, moduleUuid: seed.moduleUuid, lookup };
		expect(searchScreenOpeningCovered(inputs, environment)).toBe(true);
		const read = readPreviewScreen(() =>
			openSearchRunState(
				seed.moduleUuid,
				inputs,
				{
					context: { userid: "worker", username: "worker" },
					user: {},
					userPropertySlugs: {},
				},
				environment,
			),
		);
		expect(read.kind).toBe("refused");
		if (read.kind === "refused")
			expect(previewDataRefusalOf(read.refusal)?.reason).toMatchObject({
				kind: "empty-choice-table",
				tableId: table.tableId,
			});
	});
});
