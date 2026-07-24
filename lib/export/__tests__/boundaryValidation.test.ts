import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { loadAssetsByIds } from "@/lib/db/mediaAssets";
import type { LookupReferenceExtractorRegistry } from "@/lib/doc/lookupReferences";
import type { LookupOptionsSource, Uuid } from "@/lib/domain";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import { lookupTableIdSchema } from "@/lib/domain/lookupIds";
import {
	getLookupDefinitions,
	getLookupFixtureData,
} from "@/lib/lookup/service";
import type { LookupRowId } from "@/lib/lookup/types";
import { resolveMediaManifest } from "@/lib/media/manifest";
import {
	prepareExportBoundary,
	prepareExportBoundaryWithRegistry,
} from "../boundaryValidation";

vi.mock("@/lib/db/mediaAssets", () => ({ loadAssetsByIds: vi.fn() }));
vi.mock("@/lib/lookup/service", () => ({
	getLookupDefinitions: vi.fn(),
	getLookupFixtureData: vi.fn(),
}));
vi.mock("@/lib/media/manifest", () => ({ resolveMediaManifest: vi.fn() }));
vi.mock("@/lib/db/rolloutCompatibility", () => ({
	readLookupActivationFlags: vi.fn(async () => ({
		carrierCommitsEnabled: false,
		caseOperationsEnabled: false,
	})),
}));

const ACCESS = {
	projectId: "project-1",
	role: "owner",
	actorUserId: "user-1",
} as const;

function validDoc() {
	return buildDoc({
		appName: "Tracker",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: "Name" },
					{ name: "village", label: "Village" },
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: "Name",
								case_property_on: "patient",
							}),
							f({
								kind: "text",
								id: "village",
								label: "Village",
								case_property_on: "patient",
							}),
						],
					},
				],
			},
		],
	});
}

const EMPTY_DEFINITIONS: readonly [] = [];
const EMPTY_SNAPSHOT = {
	projectId: ACCESS.projectId,
	projectRevision: "7",
	definitions: EMPTY_DEFINITIONS,
} as const;
const EMPTY_FIXTURE_SNAPSHOT = {
	...EMPTY_SNAPSHOT,
	rowsByTable: new Map(),
} as const;

const CARRIER_TABLE = "018f3e8a-7b2c-7def-8abc-1234567890ab" as LookupTableId;
const CARRIER_VALUE_COLUMN =
	"018f3e8a-7b2c-7def-8abc-1234567890ad" as LookupColumnId;
const CARRIER_LABEL_COLUMN =
	"018f3e8a-7b2c-7def-8abc-1234567890ae" as LookupColumnId;
const CARRIER_SOURCE: LookupOptionsSource = {
	kind: "lookup-table",
	tableId: CARRIER_TABLE,
	valueColumnId: CARRIER_VALUE_COLUMN,
	labelColumnId: CARRIER_LABEL_COLUMN,
};
const CARRIER_SNAPSHOT = {
	projectId: ACCESS.projectId,
	projectRevision: "8",
	definitions: [
		{
			id: CARRIER_TABLE,
			name: "Statuses",
			tag: "statuses",
			definitionRevision: "6",
			columns: [
				{
					id: CARRIER_VALUE_COLUMN,
					wireName: "value",
					label: "Value",
					dataType: "text",
				},
				{
					id: CARRIER_LABEL_COLUMN,
					wireName: "label",
					label: "Label",
					dataType: "text",
				},
			],
		},
	],
} as const;

function lookupCarrierDoc() {
	return buildDoc({
		appName: "Lookup survey",
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [
							f({
								kind: "single_select",
								id: "status",
								label: "Status",
								options: [
									{
										uuid: "40000000-0000-4000-8000-000000000000" as Uuid,
										order: "a0",
										value: "active",
										label: "Active",
									},
									{
										uuid: "50000000-0000-4000-8000-000000000000" as Uuid,
										order: "a1",
										value: "closed",
										label: "Closed",
									},
								],
								optionsSource: CARRIER_SOURCE,
							}),
						],
					},
				],
			},
		],
	});
}

beforeEach(() => {
	vi.mocked(getLookupDefinitions).mockReset();
	vi.mocked(getLookupFixtureData).mockReset();
	vi.mocked(loadAssetsByIds).mockReset();
	vi.mocked(resolveMediaManifest).mockReset();
	vi.mocked(getLookupDefinitions).mockResolvedValue(EMPTY_SNAPSHOT as never);
	vi.mocked(getLookupFixtureData).mockResolvedValue(
		EMPTY_FIXTURE_SNAPSHOT as never,
	);
	vi.mocked(loadAssetsByIds).mockResolvedValue([]);
	vi.mocked(resolveMediaManifest).mockResolvedValue(new Map());
});

describe("prepareExportBoundary", () => {
	it.each([
		["ccz", "ccz"],
		["hq-json", "hq-json"],
		["hq-upload", "hq-upload"],
	] as const)(
		"maps %s intent without collapsing it",
		async (mode, expected) => {
			const result = await prepareExportBoundary({
				mode,
				access: ACCESS,
				doc: validDoc(),
				compiledAtSeq: 12,
			});

			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error("expected prepared export");
			expect(result.prepared.mode).toBe(expected);
			expect(result.prepared.compiledAtSeq).toBe(12);
		},
	);

	it("loads a rows-free Project snapshot even for the empty production target set", async () => {
		const result = await prepareExportBoundary({
			mode: "hq-json",
			access: ACCESS,
			doc: validDoc(),
			compiledAtSeq: 4,
		});

		expect(result.ok).toBe(true);
		expect(getLookupDefinitions).toHaveBeenCalledWith(
			{
				projectId: "project-1",
				actorId: "user-1",
				role: "owner",
			},
			[],
		);
		expect(getLookupFixtureData).not.toHaveBeenCalled();
	});

	it("loads the definitions-plus-rows snapshot on ccz, even for the empty target set", async () => {
		const result = await prepareExportBoundary({
			mode: "ccz",
			access: ACCESS,
			doc: validDoc(),
			compiledAtSeq: 4,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected prepared export");
		expect(getLookupFixtureData).toHaveBeenCalledWith(
			{
				projectId: "project-1",
				actorId: "user-1",
				role: "owner",
			},
			[],
		);
		expect(getLookupDefinitions).not.toHaveBeenCalled();
		/* No referenced table — nothing to embed, so no prepared lookup wire. */
		expect(result.prepared.lookupWire).toBeUndefined();
	});

	it("returns the exact validated definition generation with prepared resources", async () => {
		const assets = new Map();
		vi.mocked(resolveMediaManifest).mockResolvedValue(assets);
		const result = await prepareExportBoundary({
			mode: "hq-json",
			access: ACCESS,
			doc: validDoc(),
			compiledAtSeq: 9,
		});

		if (!result.ok) throw new Error("expected prepared export");
		expect(result.prepared.lookupSnapshot).toBe(EMPTY_SNAPSHOT);
		expect(result.prepared.lookupContext.definitions).toBe(
			EMPTY_SNAPSHOT.definitions,
		);
		expect(result.prepared.lookupContext).toMatchObject({
			kind: "available",
			projectId: "project-1",
			projectRevision: "7",
		});
		expect(result.prepared.assets).toBe(assets);
	});

	it("propagates an operational definition-read failure before media byte resolution", async () => {
		const operational = new Error("lookup database unavailable");
		vi.mocked(getLookupDefinitions).mockRejectedValueOnce(operational);
		vi.mocked(getLookupFixtureData).mockRejectedValueOnce(operational);

		await expect(
			prepareExportBoundary({
				mode: "hq-upload",
				access: ACCESS,
				doc: validDoc(),
				compiledAtSeq: 3,
			}),
		).rejects.toBe(operational);
		expect(loadAssetsByIds).not.toHaveBeenCalled();
		expect(resolveMediaManifest).not.toHaveBeenCalled();
	});

	it("rejects a mutable synthetic registry before reading any resources", () => {
		expect(() =>
			prepareExportBoundaryWithRegistry(
				{
					mode: "ccz",
					access: ACCESS,
					doc: validDoc(),
					compiledAtSeq: 1,
				},
				[],
			),
		).toThrow("must be frozen");
		expect(getLookupDefinitions).not.toHaveBeenCalled();
		expect(resolveMediaManifest).not.toHaveBeenCalled();
	});

	it("gives missing and foreign table ids the same not-available violation shape", async () => {
		const tableId = lookupTableIdSchema.parse(
			"00000000-0000-7000-8000-000000000001",
		);
		const registry: LookupReferenceExtractorRegistry = Object.freeze([
			Object.freeze({
				registrySlot: "synthetic.lookup",
				extract: () => [
					{
						carrierUuid: "00000000-0000-7000-8000-000000000002" as never,
						subpath: ["table"],
						tableId,
						location: { scope: "app" as const, field: "lookup" },
					},
				],
			}),
		]);

		/* The Project-scoped reader deliberately returns no definition for both
		 * a nonexistent id and an id that belongs to a different Project. The
		 * boundary and validator receive exactly the same observable snapshot. */
		const missing = await prepareExportBoundaryWithRegistry(
			{
				mode: "ccz",
				access: ACCESS,
				doc: validDoc(),
				compiledAtSeq: 1,
			},
			registry,
		);
		const foreign = await prepareExportBoundaryWithRegistry(
			{
				mode: "ccz",
				access: ACCESS,
				doc: validDoc(),
				compiledAtSeq: 1,
			},
			registry,
		);

		expect(missing.ok).toBe(false);
		expect(foreign.ok).toBe(false);
		if (missing.ok || foreign.ok) throw new Error("expected lookup rejection");
		expect(missing.violations).toEqual(foreign.violations);
		expect(missing.violations.map((finding) => finding.code)).toContain(
			"LOOKUP_TABLE_NOT_AVAILABLE",
		);
		expect(resolveMediaManifest).not.toHaveBeenCalled();
	});

	it.each(["hq-json", "hq-upload"] as const)(
		"keeps dormant lookup carriers closed for %s exports with a mode-aware finding",
		async (mode) => {
			vi.mocked(getLookupDefinitions).mockResolvedValue(
				CARRIER_SNAPSHOT as never,
			);

			const result = await prepareExportBoundary({
				mode,
				access: ACCESS,
				doc: lookupCarrierDoc(),
				compiledAtSeq: 15,
			});

			expect(result.ok).toBe(false);
			if (result.ok) throw new Error("expected dormant export rejection");
			const finding = result.violations.find(
				(candidate) => candidate.code === "LOOKUP_CARRIER_EXPORT_NOT_ACTIVE",
			);
			expect(finding?.details).toMatchObject({
				exportMode: mode,
				carrierSlot: "lookup_options_source",
			});
			expect(resolveMediaManifest).not.toHaveBeenCalled();
		},
	);

	it("prepares carrier-bearing ccz exports with the budget-checked lookup wire", async () => {
		vi.mocked(getLookupFixtureData).mockResolvedValue({
			...CARRIER_SNAPSHOT,
			rowsByTable: new Map([
				[
					CARRIER_TABLE,
					[
						{
							id: "018f3e8a-7b2c-7def-8abc-123456789100" as LookupRowId,
							values: {
								[CARRIER_VALUE_COLUMN]: "active",
								[CARRIER_LABEL_COLUMN]: "Active",
							},
						},
						{
							id: "018f3e8a-7b2c-7def-8abc-123456789101" as LookupRowId,
							values: {
								[CARRIER_VALUE_COLUMN]: "closed",
								[CARRIER_LABEL_COLUMN]: "Closed",
							},
						},
					],
				],
			]),
		} as never);

		const result = await prepareExportBoundary({
			mode: "ccz",
			access: ACCESS,
			doc: lookupCarrierDoc(),
			compiledAtSeq: 15,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected prepared ccz export");
		const wire = result.prepared.lookupWire;
		expect(wire).toBeDefined();
		expect(wire?.naming.tableFor(CARRIER_TABLE).instanceId).toBe(
			"item-list:statuses",
		);
		expect(wire?.fixtures.fixtures.map((fixture) => fixture.xml)).toEqual([
			'<fixture id="item-list:statuses"><statuses_list><statuses><value>active</value><label>Active</label></statuses><statuses><value>closed</value><label>Closed</label></statuses></statuses_list></fixture>',
		]);
		expect(wire?.fixtures.totalRows).toBe(2);
		expect(wire?.fixtures.totalCells).toBe(4);
	});

	it("rejects a ccz export whose select-source rows are invalid", async () => {
		vi.mocked(getLookupFixtureData).mockResolvedValue({
			...CARRIER_SNAPSHOT,
			rowsByTable: new Map([
				[
					CARRIER_TABLE,
					[
						{
							id: "018f3e8a-7b2c-7def-8abc-123456789200" as LookupRowId,
							values: {
								[CARRIER_VALUE_COLUMN]: "has space",
								[CARRIER_LABEL_COLUMN]: "   ",
							},
						},
					],
				],
			]),
		} as never);

		const result = await prepareExportBoundary({
			mode: "ccz",
			access: ACCESS,
			doc: lookupCarrierDoc(),
			compiledAtSeq: 16,
		});

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected ccz row-validity rejection");
		const codes = result.violations.map((violation) => violation.code);
		expect(codes).toContain("LOOKUP_SELECT_SOURCE_VALUE_WHITESPACE");
		expect(codes).toContain("LOOKUP_SELECT_SOURCE_LABEL_BLANK");
		expect(resolveMediaManifest).not.toHaveBeenCalled();
	});

	it("rejects a ccz export whose embedded fixtures exceed the aggregate row budget", async () => {
		const rows = Array.from({ length: 10_001 }, (_, index) => ({
			id: `018f3e8a-7b2c-7def-8abc-${String(index).padStart(12, "0")}` as LookupRowId,
			values: {
				[CARRIER_VALUE_COLUMN]: `v${index}`,
				[CARRIER_LABEL_COLUMN]: `Label ${index}`,
			},
		}));
		vi.mocked(getLookupFixtureData).mockResolvedValue({
			...CARRIER_SNAPSHOT,
			rowsByTable: new Map([[CARRIER_TABLE, rows]]),
		} as never);

		const result = await prepareExportBoundary({
			mode: "ccz",
			access: ACCESS,
			doc: lookupCarrierDoc(),
			compiledAtSeq: 17,
		});

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected ccz budget rejection");
		const finding = result.violations.find(
			(violation) => violation.code === "LOOKUP_FIXTURE_EXPORT_TOO_LARGE",
		);
		expect(finding?.details).toMatchObject({
			rowsActual: "10001",
			rowsAllowed: "10000",
		});
	});
});
