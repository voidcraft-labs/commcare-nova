import { describe, expect, it } from "vitest";
import { projectLookupDefinitionContext } from "@/components/builder/editor/fields/projectLookupDefinitionContext";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import type {
	LookupRevision,
	LookupTableManifestEntry,
	LookupTableSnapshot,
} from "@/lib/lookup/types";

const tableA = lookupTableIdSchema.parse(
	"01912d68-783e-7000-8000-00000000a001",
);
const tableB = lookupTableIdSchema.parse(
	"01912d68-783e-7000-8000-00000000a002",
);
const column = lookupColumnIdSchema.parse(
	"01912d68-783e-7000-8000-00000000c001",
);
const revision = (value: string) => value as LookupRevision;

function manifest(
	id = tableA,
	tableRevision = revision("8"),
): LookupTableManifestEntry {
	return {
		id,
		name: "Facilities",
		tag: "facilities",
		definitionRevision: revision("8"),
		rowsRevision: revision("7"),
		tableRevision,
		columnCount: 1,
		rowCount: 2,
		dataBytes: 42,
	};
}

function snapshot(
	id = tableA,
	tableRevision = revision("8"),
): LookupTableSnapshot {
	return {
		projectId: "project-a",
		projectRevision: revision("9"),
		id,
		name: "Facilities",
		tag: "facilities",
		definitionRevision: revision("8"),
		rowsRevision: revision("7"),
		tableRevision,
		columns: [
			{
				id: column,
				wireName: "name",
				label: "Name",
				dataType: "text",
			},
		],
		columnCount: 1,
		rows: [],
		rowCount: 0,
		dataBytes: 0,
		createdBy: "author",
		updatedBy: "author",
		createdAt: "2026-07-26T00:00:00.000Z",
		updatedAt: "2026-07-26T00:00:00.000Z",
	};
}

describe("projectLookupDefinitionContext", () => {
	it("carries the exact focused definition and its revisions", () => {
		expect(
			projectLookupDefinitionContext({
				focusedTableId: tableA,
				manifestEntry: manifest(),
				snapshot: snapshot(),
			}),
		).toEqual({
			kind: "available",
			projectId: "project-a",
			projectRevision: revision("9"),
			definitions: [
				{
					id: tableA,
					name: "Facilities",
					tag: "facilities",
					definitionRevision: revision("8"),
					columns: [
						{
							id: column,
							wireName: "name",
							label: "Name",
							dataType: "text",
						},
					],
				},
			],
		});
	});

	it("stays fail-closed when a kept-stale body belongs to another table", () => {
		expect(
			projectLookupDefinitionContext({
				focusedTableId: tableB,
				manifestEntry: manifest(tableB),
				snapshot: snapshot(tableA),
			}),
		).toBe(LOOKUP_CONTEXT_UNAVAILABLE);
	});

	it("stays fail-closed until a stale table revision catches up", () => {
		expect(
			projectLookupDefinitionContext({
				focusedTableId: tableA,
				manifestEntry: manifest(tableA, revision("9")),
				snapshot: snapshot(tableA, revision("8")),
			}),
		).toBe(LOOKUP_CONTEXT_UNAVAILABLE);
	});
});
