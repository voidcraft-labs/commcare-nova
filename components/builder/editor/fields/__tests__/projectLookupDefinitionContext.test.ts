import { describe, expect, it } from "vitest";
import {
	projectLookupDefinitionContext,
	projectLookupDefinitionReadVerdict,
} from "@/components/builder/editor/fields/projectLookupDefinitionContext";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import type {
	LookupDefinitionsSnapshot,
	LookupRevision,
	LookupTableManifestEntry,
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
	definitionRevision = revision("8"),
): LookupTableManifestEntry {
	return {
		id,
		name: "Facilities",
		tag: "facilities",
		definitionRevision,
		rowsRevision: revision("7"),
		tableRevision: definitionRevision,
		columnCount: 1,
		rowCount: 2,
		dataBytes: 42,
	};
}

function snapshot(
	id = tableA,
	definitionRevision = revision("8"),
	projectId = "project-a",
): LookupDefinitionsSnapshot {
	return {
		projectId,
		projectRevision: revision("9"),
		definitions: [
			{
				id,
				name: "Facilities",
				tag: "facilities",
				definitionRevision,
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
	};
}

describe("projectLookupDefinitionContext", () => {
	it("carries the exact focused definition and its revisions", () => {
		expect(
			projectLookupDefinitionContext({
				currentProjectId: "project-a",
				manifestProjectId: "project-a",
				manifestProjectRevision: revision("9"),
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
				currentProjectId: "project-a",
				manifestProjectId: "project-a",
				manifestProjectRevision: revision("9"),
				focusedTableId: tableB,
				manifestEntry: manifest(tableB),
				snapshot: snapshot(tableA),
			}),
		).toBe(LOOKUP_CONTEXT_UNAVAILABLE);
	});

	it("stays fail-closed until a stale definition revision catches up", () => {
		expect(
			projectLookupDefinitionContext({
				currentProjectId: "project-a",
				manifestProjectId: "project-a",
				manifestProjectRevision: revision("9"),
				focusedTableId: tableA,
				manifestEntry: manifest(tableA, revision("9")),
				snapshot: snapshot(tableA, revision("8")),
			}),
		).toBe(LOOKUP_CONTEXT_UNAVAILABLE);
	});

	it("stays fail-closed when the rows-free snapshot belongs to another Project", () => {
		expect(
			projectLookupDefinitionContext({
				currentProjectId: "project-a",
				manifestProjectId: "project-a",
				manifestProjectRevision: revision("9"),
				focusedTableId: tableA,
				manifestEntry: manifest(),
				snapshot: snapshot(tableA, revision("8"), "project-b"),
			}),
		).toBe(LOOKUP_CONTEXT_UNAVAILABLE);
	});

	it("stays fail-closed when the manifest is from the previous Project", () => {
		expect(
			projectLookupDefinitionContext({
				currentProjectId: "project-a",
				manifestProjectId: "project-b",
				manifestProjectRevision: revision("9"),
				focusedTableId: tableA,
				manifestEntry: manifest(),
				snapshot: snapshot(),
			}),
		).toBe(LOOKUP_CONTEXT_UNAVAILABLE);
	});

	it("stays fail-closed when independently settled Project generations differ", () => {
		expect(
			projectLookupDefinitionContext({
				currentProjectId: "project-a",
				manifestProjectId: "project-a",
				manifestProjectRevision: revision("10"),
				focusedTableId: tableA,
				manifestEntry: manifest(),
				snapshot: snapshot(),
			}),
		).toBe(LOOKUP_CONTEXT_UNAVAILABLE);
	});
});

describe("projectLookupDefinitionReadVerdict", () => {
	it("turns settled generation drift into Retry instead of permanent Loading", () => {
		expect(
			projectLookupDefinitionReadVerdict({
				currentProjectId: "project-a",
				manifestProjectId: "project-a",
				focusedTableId: tableA,
				manifestProjectRevision: revision("10"),
				manifestEntry: manifest(),
				snapshot: snapshot(),
			}),
		).toEqual({ kind: "retry" });
	});

	it("calls an omission deleted only when both reads share one generation", () => {
		expect(
			projectLookupDefinitionReadVerdict({
				currentProjectId: "project-a",
				manifestProjectId: "project-a",
				focusedTableId: tableA,
				manifestProjectRevision: revision("9"),
				manifestEntry: undefined,
				snapshot: {
					projectId: "project-a",
					projectRevision: revision("9"),
					definitions: [],
				},
			}),
		).toEqual({ kind: "deleted" });
	});

	it("requires Retry when only one coherent read contains the table", () => {
		expect(
			projectLookupDefinitionReadVerdict({
				currentProjectId: "project-a",
				manifestProjectId: "project-a",
				focusedTableId: tableA,
				manifestProjectRevision: revision("9"),
				manifestEntry: manifest(),
				snapshot: {
					projectId: "project-a",
					projectRevision: revision("9"),
					definitions: [],
				},
			}),
		).toEqual({ kind: "retry" });
	});
});
