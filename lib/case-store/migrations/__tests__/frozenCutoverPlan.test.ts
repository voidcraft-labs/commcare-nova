import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertFrozenRepairAllowedDelta,
	classifyFrozenMigrationCutoverState,
	createFrozenCutoverPlan,
	frozenRawCarrierEvidence,
	reviewedFrozenCapacity,
} from "../20260728000000_canonical_identity_foundation/frozenCutoverPlan";
import {
	type FrozenStorageSnapshot,
	frozenExactTextSequenceDigest,
} from "../20260728000000_canonical_identity_foundation/frozenOccurrenceDispatcher";
import { FROZEN_STORAGE_OCCURRENCES } from "../20260728000000_canonical_identity_foundation/frozenOccurrenceManifest";
import {
	CANONICAL_IDENTITY_CATALOG_CLEARS,
	CANONICAL_IDENTITY_LABEL_REPAIR,
	CANONICAL_IDENTITY_PROPERTY_PROJECTIONS,
	CANONICAL_IDENTITY_ROW_DELETES,
} from "../20260728000000_canonical_identity_foundation/frozenRepairManifest";

const TIMESTAMP_DIR = join(
	process.cwd(),
	"lib/case-store/migrations/20260728000000_canonical_identity_foundation",
);

function rawSnapshot(
	overrides: Readonly<Record<string, readonly string[]>> = {},
): FrozenStorageSnapshot {
	const rows = (table: string) => overrides[table] ?? [];
	return Object.fromEntries(
		[
			"apps",
			"blueprint_entities",
			"app_changes",
			"case_type_schemas",
			"lookup_rows",
		].map((table) => [
			table,
			{ exists: true, rows: [], rowTexts: rows(table) },
		]),
	);
}

function cutoverInput() {
	return {
		mode: "migration" as const,
		state: "pristine" as const,
		lockRelations: ["public.apps"],
		apps: [],
		rawCarriers: [],
		leaseState: {
			appLeaseBlockers: "0",
			activeThreadHolders: "0",
			unterminatedChunks: "0",
			presenceSessions: "0",
			settledReservationRemnants: "0",
			digest: "lease",
		},
		lookupContexts: [],
		referenceIndexDigest: "references",
		schemaDefinitionDigest: "schema",
		baselineCatalogDigest: "baseline",
		dependencyCatalogDigest: "dependencies",
		relationAndIndexAclDigest: "relation-acl",
		functionCatalogDigest: "function-catalog",
		capacity: reviewedFrozenCapacity({
			apps: "1",
			entities: "2",
			sourceBytes: ["3", "4"],
			rewriteBytes: "5",
		}),
		findings: [],
	};
}

describe("frozen canonical-identity CutoverPlan", () => {
	it("classifies only the exact pristine and applied migration states", () => {
		expect(
			classifyFrozenMigrationCutoverState({
				identitySqlType: "text",
				baselineCatalog: "absent",
				appCount: "12",
				baselineAppCount: "0",
				baselineCount: "0",
			}),
		).toBe("pristine");
		expect(
			classifyFrozenMigrationCutoverState({
				identitySqlType: "uuid",
				baselineCatalog: "exact",
				appCount: "12",
				baselineAppCount: "12",
				baselineCount: "12",
			}),
		).toBe("applied");
		expect(
			classifyFrozenMigrationCutoverState({
				identitySqlType: "uuid",
				baselineCatalog: "exact",
				appCount: "12",
				baselineAppCount: "12",
				baselineCount: "19",
			}),
		).toBe("applied");
		expect(
			classifyFrozenMigrationCutoverState({
				identitySqlType: "uuid",
				baselineCatalog: "exact",
				appCount: "0",
				baselineAppCount: "0",
				baselineCount: "0",
			}),
		).toBe("applied");
		expect(
			classifyFrozenMigrationCutoverState({
				identitySqlType: "uuid",
				baselineCatalog: "exact",
				appCount: "12",
				baselineAppCount: "4",
				baselineCount: "4",
			}),
		).toBe("mixed");
		expect(
			classifyFrozenMigrationCutoverState({
				identitySqlType: "other",
				baselineCatalog: "partial-or-drift",
				appCount: "12",
				baselineAppCount: "4",
				baselineCount: "4",
			}),
		).toBe("drift");
	});

	it("uses exact length-framed PostgreSQL row text evidence", () => {
		expect(frozenExactTextSequenceDigest(["ab", "c"])).not.toBe(
			frozenExactTextSequenceDigest(["a", "bc"]),
		);
		const evidence = frozenRawCarrierEvidence(
			rawSnapshot({
				apps: ['{"huge":9007199254740993}', '{"value":null}'],
			}),
		).find((entry) => entry.table === "apps");
		expect(evidence).toMatchObject({
			rows: "2",
			bytes: String(
				Buffer.byteLength('{"huge":9007199254740993}', "utf8") +
					Buffer.byteLength('{"value":null}', "utf8"),
			),
		});
	});

	it("requires lock inventory and reviewed capacity, but not an idle service", () => {
		const plan = createFrozenCutoverPlan(cutoverInput());
		expect(plan.lockMode).toBe("SHARE ROW EXCLUSIVE");
		expect(plan.capacity.withinReviewedBounds).toBe(true);

		/* Someone having a builder tab open is not a reason to refuse the
		 * cutover. The lock mode above is what protects it; requiring these to be
		 * zero would only be satisfiable by taking the service down. The counts
		 * are still recorded in the plan. */
		const busy = createFrozenCutoverPlan({
			...cutoverInput(),
			leaseState: {
				...cutoverInput().leaseState,
				presenceSessions: "1",
				unterminatedChunks: "17",
			},
		});
		expect(busy.leaseState.presenceSessions).toBe("1");
		expect(busy.leaseState.unterminatedChunks).toBe("17");

		// A malformed counter is still a refusal — that is a broken read, not a
		// busy service.
		expect(() =>
			createFrozenCutoverPlan({
				...cutoverInput(),
				leaseState: { ...cutoverInput().leaseState, presenceSessions: "-1" },
			}),
		).toThrow();
		expect(() =>
			createFrozenCutoverPlan({
				...cutoverInput(),
				capacity: {
					...cutoverInput().capacity,
					rewriteBytes: "536870913",
					walBytes: "1073741826",
				},
			}),
		).toThrow(/capacity bound/);
	});

	it("preserves the entire lookup_rows table byte exactly", () => {
		const source = rawSnapshot({
			lookup_rows: [
				'{"id":"row","values":{"huge":9007199254740993,"value":null}}',
			],
		});
		expect(() => assertFrozenRepairAllowedDelta(source, source)).not.toThrow();
		expect(() =>
			assertFrozenRepairAllowedDelta(
				source,
				rawSnapshot({
					lookup_rows: [
						'{"id":"row","values":{"huge":9007199254740992,"value":null}}',
					],
				}),
			),
		).toThrow(/lookup_rows/);
	});
});

describe("frozen repair and catalog source contracts", () => {
	it("pins the exact six label byte spans and typed replacements", () => {
		expect(CANONICAL_IDENTITY_ROW_DELETES).toHaveLength(42);
		expect(CANONICAL_IDENTITY_PROPERTY_PROJECTIONS).toHaveLength(2);
		expect(CANONICAL_IDENTITY_CATALOG_CLEARS).toHaveLength(2);
		expect(CANONICAL_IDENTITY_LABEL_REPAIR.replacementParts).toHaveLength(6);
		expect(
			CANONICAL_IDENTITY_LABEL_REPAIR.replacementParts.map((part) => [
				part.startByte,
				part.endByte,
				part.sourceDigest,
				part.replacement?.kind ?? null,
				part.replacement?.uuid ?? null,
			]),
		).toEqual([
			[
				12,
				45,
				"db018b51b2bdf63fbe9427ec4fd235c8a568ce911f01549222a4d8850cbfa297",
				"field-ref",
				"d0ee8c4c-d357-4586-99c8-dd38f8e11a84",
			],
			[
				63,
				96,
				"61f0fac2bb6cff7a90ba9d8f5058324b4e9cbedffa84f2123aeb83f98d3afbdb",
				"field-ref",
				"46fc2817-e81d-4670-a7c3-a051160060c1",
			],
			[
				112,
				122,
				"223a43028e7a3b19c3b91a32c9623ecd9fdc25c5a65ee1e157efa3de623cbb65",
				null,
				null,
			],
			[
				145,
				162,
				"c47af2e350ff8ac0c419b24098866bce1cf5504ac9ed240b37b3c303a7e99c48",
				"field-ref",
				"b1e6791c-f38d-4425-8682-91e75af560b5",
			],
			[
				189,
				213,
				"f9b70c76662b166d9d28f6cd9f50cf2a36888fc93a2fcd35f1ca669560f42a53",
				"field-ref",
				"7824589e-81f5-4a1c-898a-8afa016b9435",
			],
			[
				234,
				252,
				"f4e6d453282d1bd701ae3990852141410f765e34a47a243b0b6a8a2fc83d1fb6",
				"field-ref",
				"9b32a512-424a-4bfe-ade9-052f07b4d93d",
			],
		]);
	});

	it("keeps scanner, repair, and migration on the same plan authority", () => {
		for (const file of [
			"frozenScanner.ts",
			"frozenDatabaseRepair.ts",
			"frozenDatabaseMigration.ts",
		]) {
			const source = readFileSync(join(TIMESTAMP_DIR, file), "utf8");
			expect(source).toContain("createFrozenCutoverPlan");
			expect(source).toContain("captureFrozenCutoverLeaseState");
			expect(source).toContain("captureFrozenCutoverCatalogEvidence");
		}
		const migration = readFileSync(
			join(TIMESTAMP_DIR, "frozenDatabaseMigration.ts"),
			"utf8",
		);
		expect(migration).not.toContain("UPDATE lookup_rows");
		expect(
			FROZEN_STORAGE_OCCURRENCES.find(
				(entry) => entry.id === "lookup_rows.identity-and-values",
			)?.disposition,
		).toBe("preserve-exact");
	});

	it("keeps repair byte-manifest-driven and catalog closure recursive", () => {
		const repair = readFileSync(join(TIMESTAMP_DIR, "frozenRepair.ts"), "utf8");
		expect(repair).toContain("repair.replacementParts");
		expect(repair).toContain("rawUtf8Digest(tokenBytes)");
		expect(repair).not.toContain("matchAll(");
		expect(repair).not.toContain("HASHTAG");

		const cutover = readFileSync(
			join(TIMESTAMP_DIR, "frozenCutoverPlan.ts"),
			"utf8",
		);
		expect(cutover).toContain("WITH RECURSIVE dependency AS");
		expect(cutover).toContain("pg_catalog.pg_depend");
		expect(cutover).toContain(
			"constraint_row.confrelid = 'public.apps'::regclass",
		);
		expect(cutover).toContain("pg_get_functiondef(function_row.oid)");
		expect(cutover).toContain("pg_catalog.pg_get_constraintdef(");
		expect(cutover).toContain("pg_catalog.pg_get_triggerdef(");
		expect(cutover).toContain("pg_catalog.format_type(");
		expect(cutover).toContain("function_row.proacl");
		expect(cutover).toContain("function_row.proconfig");
		expect(cutover).toContain("index_relation.relacl");
	});
});
