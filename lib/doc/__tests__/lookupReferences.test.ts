import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	canonicalLookupReferenceSubpath,
	EMPTY_LOOKUP_REFERENCE_TARGETS,
	extractLookupReferenceOccurrences,
	extractLookupReferenceTargets,
	lookupReferenceTargetsFromOccurrences,
	normalizeLookupReferenceTargetSet,
	PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS,
	type LookupReferenceExtractorRegistry,
	unionLookupReferenceTargetSets,
} from "@/lib/doc/lookupReferences";
import { asUuid } from "@/lib/domain";
import type {
	LookupColumnId,
	LookupTableId,
} from "@/lib/domain/lookupIds";

const tableId = (suffix: string) =>
	`00000000-0000-7000-8000-${suffix.padStart(12, "0")}` as LookupTableId;
const columnId = (suffix: string) =>
	`10000000-0000-7000-8000-${suffix.padStart(12, "0")}` as LookupColumnId;

describe("lookup reference extraction", () => {
	it("keeps the production registry immutable and empty until a carrier lands", () => {
		const doc = buildDoc({ appName: "No carriers" });
		expect(Object.isFrozen(PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS)).toBe(true);
		expect(
			extractLookupReferenceOccurrences(
				doc,
				PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS,
			),
		).toEqual([]);
		expect(extractLookupReferenceTargets(doc)).toBe(
			EMPTY_LOOKUP_REFERENCE_TARGETS,
		);
	});

	it("canonicalizes typed nested paths without key/index aliases", () => {
		expect(canonicalLookupReferenceSubpath([])).toBe("");
		expect(canonicalLookupReferenceSubpath(["rows", 0, "a/b~c"])).toBe(
			"/k:rows/i:0/k:a~1b~0c",
		);
		expect(canonicalLookupReferenceSubpath(["0"])).not.toBe(
			canonicalLookupReferenceSubpath([0]),
		);
		expect(() => canonicalLookupReferenceSubpath([-1])).toThrow(
			"nonnegative safe integers",
		);
	});

	it("stamps an explicit synthetic registry and returns deterministic occurrences", () => {
		const doc = buildDoc({ appName: "Synthetic" });
		const registry: LookupReferenceExtractorRegistry = Object.freeze([
			{
				registrySlot: "future.itemset.value",
				extract: () => [
					{
						carrierUuid: asUuid("carrier-b"),
						subpath: ["value", 1],
						tableId: tableId("2"),
						columnId: columnId("2"),
						acceptedColumnTypes: ["decimal", "int", "decimal"],
						location: { scope: "field", fieldUuid: asUuid("carrier-b") },
					},
					{
						carrierUuid: asUuid("carrier-a"),
						subpath: ["value", 0],
						tableId: tableId("1"),
						location: { scope: "module", moduleUuid: asUuid("carrier-a") },
					},
				],
			},
		]);

		const occurrences = extractLookupReferenceOccurrences(doc, registry);
		expect(occurrences.map((occurrence) => occurrence.carrierUuid)).toEqual([
			"carrier-a",
			"carrier-b",
		]);
		expect(occurrences[1]).toMatchObject({
			registrySlot: "future.itemset.value",
			subpath: "/k:value/i:1",
			acceptedColumnTypes: ["int", "decimal"],
		});
		expect(Object.isFrozen(occurrences)).toBe(true);
		expect(Object.isFrozen(occurrences[1].acceptedColumnTypes)).toBe(true);
	});

	it("rejects duplicate registry slots and a type contract without a column", () => {
		const doc = buildDoc();
		const extractor = {
			registrySlot: "future.slot",
			extract: () => [],
		};
		expect(() =>
			extractLookupReferenceOccurrences(doc, [extractor, extractor]),
		).toThrow("Duplicate lookup reference registry slot");

		expect(() =>
			extractLookupReferenceOccurrences(doc, [
				{
					registrySlot: "future.typed",
					extract: () => [
						{
							carrierUuid: asUuid("carrier"),
							subpath: [],
							tableId: tableId("1"),
							acceptedColumnTypes: ["text"],
							location: { scope: "app" },
						},
					],
				},
			]),
		).toThrow("accepted column types without a column target");

		expect(() =>
			extractLookupReferenceOccurrences(doc, [
				{
					registrySlot: "future.empty-types",
					extract: () => [
						{
							carrierUuid: asUuid("carrier"),
							subpath: [],
							tableId: tableId("1"),
							columnId: columnId("1"),
							acceptedColumnTypes: [],
							location: { scope: "app" },
						},
					],
				},
			]),
		).toThrow("empty accepted column type set");
	});
});

describe("lookup reference target normalization", () => {
	it("sorts, deduplicates, and makes every column imply its table", () => {
		const targets = normalizeLookupReferenceTargetSet({
			tableIds: [tableId("3"), tableId("1"), tableId("1")],
			columnTargets: [
				{ tableId: tableId("2"), columnId: columnId("2") },
				{ tableId: tableId("2"), columnId: columnId("1") },
				{ tableId: tableId("2"), columnId: columnId("2") },
			],
		});

		expect(targets.tableIds).toEqual([
			tableId("1"),
			tableId("2"),
			tableId("3"),
		]);
		expect(targets.columnTargets).toEqual([
			{ tableId: tableId("2"), columnId: columnId("1") },
			{ tableId: tableId("2"), columnId: columnId("2") },
		]);
		expect(Object.isFrozen(targets.tableIds)).toBe(true);
		expect(Object.isFrozen(targets.columnTargets)).toBe(true);
	});

	it("projects occurrences and unions partitions through the same normalizer", () => {
		const occurrence = {
			carrierUuid: asUuid("carrier"),
			registrySlot: "future.slot",
			subpath: "",
			tableId: tableId("1"),
			columnId: columnId("1"),
			location: { scope: "app" as const },
		};
		const fromOccurrence = lookupReferenceTargetsFromOccurrences([occurrence]);
		const union = unionLookupReferenceTargetSets(
			fromOccurrence,
			normalizeLookupReferenceTargetSet({ tableIds: [tableId("2")] }),
			fromOccurrence,
		);

		expect(union).toEqual({
			tableIds: [tableId("1"), tableId("2")],
			columnTargets: [
				{ tableId: tableId("1"), columnId: columnId("1") },
			],
		});
		expect(normalizeLookupReferenceTargetSet({})).toBe(
			EMPTY_LOOKUP_REFERENCE_TARGETS,
		);
	});
});
