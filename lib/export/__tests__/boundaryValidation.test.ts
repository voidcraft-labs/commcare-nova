import { beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { expandDoc } from "@/lib/commcare/expander";
import { loadAssetsByIds } from "@/lib/db/mediaAssets";
import type { LookupReferenceExtractorRegistry } from "@/lib/doc/lookupReferences";
import type { LookupOptionsSource, OrganizationLevel } from "@/lib/domain";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import { lookupTableIdSchema } from "@/lib/domain/lookupIds";
import {
	fixedLocation,
	ownerLocationAtLevel,
	term,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
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
					{ name: "case_name", label: proseText("Name") },
					{ name: "village", label: proseText("Village") },
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
								label: proseText("Name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							f({
								kind: "text",
								id: "village",
								label: proseText("Village"),
								caseWrite: { caseType: "patient", property: "village" },
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
	kind: "lookup",
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
								label: proseText("Status"),
								optionsSource: CARRIER_SOURCE,
							}),
						],
					},
				],
			},
		],
	});
}

/** The carrier table with two clean rows: the generation every carrier test
 * that expects a SUCCESSFUL preparation reads. */
function carrierFixtureSnapshot() {
	return {
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
	};
}

function fixedOwnerDoc() {
	const doc = buildDoc({
		appName: "Fixed owner",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "note",
								label: proseText("Note"),
							}),
						],
					},
				],
			},
		],
	});
	const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
	doc.forms[formUuid].caseOperations = [
		{
			uuid: testUuid("11111111-1111-4111-8111-111111111111"),
			id: "set_owner",
			action: "update",
			caseType: "patient",
			target: { kind: "session" },
			owner: term(
				fixedLocation(testUuid("22222222-2222-4222-8222-222222222222")),
			),
		},
	];
	return doc;
}

const DISTRICT = testUuid("33333333-3333-4333-8333-333333333330");
const CLINIC = testUuid("33333333-3333-4333-8333-333333333333");

/**
 * A reverse hop over a real two-level organization.
 *
 * The levels are not decoration. `termEmitter.ts::emitTerm` resolves the
 * destination level and walks up for a case-owning ancestor, so a doc
 * that names a level it does not have cannot be expanded at all — and a
 * test asserting this shape EXPORTS while never compiling it would prove
 * nothing.
 */
function reverseOwnerDoc() {
	const doc = fixedOwnerDoc();
	const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
	const operation = doc.forms[formUuid].caseOperations?.[0];
	if (operation === undefined) throw new Error("owner operation missing");
	operation.owner = term(ownerLocationAtLevel(CLINIC, "patient"));
	const levels: Record<string, OrganizationLevel> = {
		[DISTRICT]: {
			uuid: DISTRICT,
			code: "district",
			name: "District",
			caseFlow: {
				workers: "assigned" as const,
				ownsCases: true,
				descendantCases: { kind: "none" as const },
			},
			addressBook: { reach: "own-branch" as const },
		},
		[CLINIC]: {
			uuid: CLINIC,
			code: "clinic",
			name: "Clinic",
			parentLevelUuid: DISTRICT,
			caseFlow: { workers: "none" as const, ownsCases: false },
			addressBook: { reach: "own-branch" as const },
		},
	};
	doc.organizationLevels = levels;
	doc.organizationLevelOrder = [DISTRICT, CLINIC];
	return doc;
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
				attachmentTarget: null,
			});

			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error("expected prepared export");
			expect(result.prepared.mode).toBe(expected);
			expect(result.prepared.compiledAtSeq).toBe(12);
		},
	);

	it.each(["ccz", "hq-json", "hq-upload"] as const)(
		"loads the definitions-plus-rows snapshot on %s, even for the empty target set",
		async (mode) => {
			const result = await prepareExportBoundary({
				mode,
				access: ACCESS,
				doc: validDoc(),
				compiledAtSeq: 4,
				attachmentTarget: null,
			});

			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error("expected prepared export");
			/* Every mode carries lookup data now: `ccz` embeds fixtures and the
			 * two HQ modes build the workbook, so all three must validate the
			 * generation they will emit rather than a rows-free one. */
			expect(getLookupFixtureData).toHaveBeenCalledWith(
				{
					projectId: "project-1",
					actorId: "user-1",
					role: "owner",
				},
				[],
			);
			expect(getLookupDefinitions).not.toHaveBeenCalled();
			/* No referenced table — nothing to carry, so neither carrier. */
			expect(result.prepared.lookupWire).toBeUndefined();
			expect(result.prepared.lookupWorkbook).toBeUndefined();
		},
	);

	it("returns the exact validated definition generation with prepared resources", async () => {
		const assets = new Map();
		vi.mocked(resolveMediaManifest).mockResolvedValue(assets);
		const result = await prepareExportBoundary({
			mode: "hq-json",
			access: ACCESS,
			doc: validDoc(),
			compiledAtSeq: 9,
			attachmentTarget: null,
		});

		if (!result.ok) throw new Error("expected prepared export");
		expect(result.prepared.lookupSnapshot).toBe(EMPTY_FIXTURE_SNAPSHOT);
		expect(result.prepared.lookupContext.definitions).toBe(
			EMPTY_FIXTURE_SNAPSHOT.definitions,
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
				attachmentTarget: null,
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
					attachmentTarget: null,
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
				attachmentTarget: null,
			},
			registry,
		);
		const foreign = await prepareExportBoundaryWithRegistry(
			{
				mode: "ccz",
				access: ACCESS,
				doc: validDoc(),
				compiledAtSeq: 1,
				attachmentTarget: null,
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
		"prepares the CommCare HQ fixture workbook for %s exports",
		async (mode) => {
			vi.mocked(getLookupFixtureData).mockResolvedValue(
				carrierFixtureSnapshot() as never,
			);

			const result = await prepareExportBoundary({
				mode,
				access: ACCESS,
				doc: lookupCarrierDoc(),
				compiledAtSeq: 15,
				attachmentTarget: null,
			});

			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error("expected prepared HQ export");
			const workbook = result.prepared.lookupWorkbook;
			expect(workbook).toBeDefined();
			expect(workbook?.tables).toEqual([
				{
					tableId: CARRIER_TABLE,
					tag: "statuses",
					columnCount: 2,
					rowCount: 2,
				},
			]);
			/* The types sheet's header plus one table row, and the data sheet's
			 * header plus its two rows: what CommCare HQ counts against its own
			 * whole-workbook limit. */
			expect(workbook?.totalWorkbookRows).toBe(5);
			/* An HQ mode carries its data as a workbook, never as embedded
			 * suite fixtures. */
			expect(result.prepared.lookupWire).toBeUndefined();
		},
	);

	it.each(["ccz", "hq-json", "hq-upload"] as const)(
		"carries lookup wire naming into %s emission",
		async (mode) => {
			/* Naming is what the APP needs, not what the DATA needs. A
			 * lookup-backed select compiles to an `instance(...)` reference
			 * whichever mode is emitting, and `buildXForm` throws outright
			 * without it, so an HQ mode that pushed the rows and then expanded
			 * without naming would put the tables on the project space and
			 * then fail with the app never sent. Every mode, therefore. */
			vi.mocked(getLookupFixtureData).mockResolvedValue(
				carrierFixtureSnapshot() as never,
			);

			const result = await prepareExportBoundary({
				mode,
				access: ACCESS,
				doc: lookupCarrierDoc(),
				compiledAtSeq: 15,
				attachmentTarget: null,
			});

			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error("expected a prepared export");
			expect(result.prepared.lookupNaming?.tableFor(CARRIER_TABLE).tag).toBe(
				"statuses",
			);

			/* The assertion that would have caught the real defect: emit the
			 * app the way the mode's own route does. */
			expect(() =>
				expandDoc(result.prepared.doc, {
					assets: result.prepared.assets,
					...(result.prepared.lookupNaming && {
						lookupNaming: result.prepared.lookupNaming,
					}),
				}),
			).not.toThrow();

			/* And the other direction, so this test cannot quietly go vacuous
			 * if the naming ever stops being required: dropping it is exactly
			 * the defect, and it must still be loud. */
			expect(() =>
				expandDoc(result.prepared.doc, { assets: result.prepared.assets }),
			).toThrow(/no lookup wire naming/i);
		},
	);

	it.each(["hq-json", "hq-upload"] as const)(
		"refuses a %s export whose tag is too long to name a data sheet",
		async (mode) => {
			const tag = "a".repeat(32);
			vi.mocked(getLookupFixtureData).mockResolvedValue({
				...carrierFixtureSnapshot(),
				definitions: [{ ...CARRIER_SNAPSHOT.definitions[0], tag }],
			} as never);

			const result = await prepareExportBoundary({
				mode,
				access: ACCESS,
				doc: lookupCarrierDoc(),
				compiledAtSeq: 15,
				attachmentTarget: null,
			});

			expect(result.ok).toBe(false);
			if (result.ok) throw new Error("expected sheet-name rejection");
			const finding = result.violations.find(
				(candidate) => candidate.code === "LOOKUP_TAG_TOO_LONG_FOR_HQ",
			);
			expect(finding?.details).toMatchObject({
				tag,
				tagLength: "32",
				tagAllowed: "31",
			});
			expect(resolveMediaManifest).not.toHaveBeenCalled();
		},
	);

	it.each(["types", "Types"] as const)(
		"refuses an HQ export whose tag is %s, the name CommCare HQ keeps",
		async (tag) => {
			/* Every upload carries a mandatory sheet named `types` listing the
			 * tables in it, so a table tagged the same has nowhere to put its
			 * rows: Nova would throw appending the second sheet and CommCare
			 * HQ would read the wrong one. Nothing in Nova's tag rules blocks
			 * it, so the boundary is what keeps the emitter total. */
			vi.mocked(getLookupFixtureData).mockResolvedValue({
				...carrierFixtureSnapshot(),
				definitions: [{ ...CARRIER_SNAPSHOT.definitions[0], tag }],
			} as never);

			const result = await prepareExportBoundary({
				mode: "hq-upload",
				access: ACCESS,
				doc: lookupCarrierDoc(),
				compiledAtSeq: 15,
				attachmentTarget: null,
			});

			expect(result.ok).toBe(false);
			if (result.ok) throw new Error("expected a reserved-tag rejection");
			const finding = result.violations.find(
				(candidate) => candidate.code === "LOOKUP_TAG_RESERVED_BY_HQ",
			);
			expect(finding?.details).toMatchObject({ tag, reservedTag: "types" });
			expect(resolveMediaManifest).not.toHaveBeenCalled();
		},
	);

	it("still embeds a types-tagged table in a ccz, whose fixtures are addressed by element name", async () => {
		vi.mocked(getLookupFixtureData).mockResolvedValue({
			...carrierFixtureSnapshot(),
			definitions: [{ ...CARRIER_SNAPSHOT.definitions[0], tag: "types" }],
		} as never);

		const result = await prepareExportBoundary({
			mode: "ccz",
			access: ACCESS,
			doc: lookupCarrierDoc(),
			compiledAtSeq: 15,
			attachmentTarget: null,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected a prepared ccz export");
		expect(result.prepared.lookupWire?.naming.tableFor(CARRIER_TABLE).tag).toBe(
			"types",
		);
	});

	it("still embeds a 32-character tag in a ccz, which addresses tables by element name", async () => {
		const tag = "a".repeat(32);
		vi.mocked(getLookupFixtureData).mockResolvedValue({
			...carrierFixtureSnapshot(),
			definitions: [{ ...CARRIER_SNAPSHOT.definitions[0], tag }],
		} as never);

		const result = await prepareExportBoundary({
			mode: "ccz",
			access: ACCESS,
			doc: lookupCarrierDoc(),
			compiledAtSeq: 15,
			attachmentTarget: null,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected prepared ccz export");
		expect(result.prepared.lookupWire?.naming.tableFor(CARRIER_TABLE).tag).toBe(
			tag,
		);
	});

	it.each(["ccz", "hq-json", "hq-upload"] as const)(
		"keeps an owner set to one particular place closed for %s exports",
		async (mode) => {
			const result = await prepareExportBoundary({
				mode,
				access: ACCESS,
				doc: fixedOwnerDoc(),
				compiledAtSeq: 16,
				attachmentTarget: null,
			});

			expect(result.ok).toBe(false);
			if (result.ok) throw new Error("expected fixed-owner rejection");
			expect(result.violations).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						code: "LOCATION_OWNER_EXPORT_NOT_ACTIVE",
						details: expect.objectContaining({
							exportMode: mode,
							ownerKind: "fixed-location",
						}),
					}),
				]),
			);

			// The refusal has exactly ONE reason left, and it has to SAY so.
			// BOTH reasons it used to give are closed: HQ builds the device
			// `locations` fixture on restore from its own rows, and
			// publishing now puts the places there and records each one's
			// `location_id`. What is left is that the compiler still writes
			// Nova's place UUID. A message naming either closed reason sends
			// an author looking for a feature that exists.
			const finding = result.violations.find(
				(candidate) => candidate.code === "LOCATION_OWNER_EXPORT_NOT_ACTIVE",
			);
			expect(finding?.message).toContain("CommCare HQ project");
			expect(finding?.message).toMatch(/Nova's own id/);
			expect(finding?.message).not.toMatch(
				/fixture|device location data|identity map/i,
			);
			/* It names the way out that WORKS, not "a different owner". The
			 * other place-based owner exports, so sending an author away
			 * from places altogether would cost them the feature. */
			expect(finding?.message).toContain(
				"a place beneath the current case owner",
			);
		},
	);

	/**
	 * The app settles whether CommCare HQ puts the locations fixture in a
	 * worker's restore, rather than hoping the project space does.
	 *
	 * `locations/fixtures.py::should_sync_flat_fixture` otherwise falls
	 * through to `LocationFixtureConfiguration.for_domain(...)`, a row an
	 * administrator can switch off — and an app that declares
	 * `jr://fixture/locations` without getting one fails to resolve the
	 * instance on the device. It returns True for
	 * `app.location_fixture_restore in const.py::SYNC_FLAT_FIXTURES`
	 * before it ever reads that row.
	 */
	it("declares the flat locations fixture when a rule reads it", () => {
		const app = expandDoc(reverseOwnerDoc());
		expect(app.location_fixture_restore).toBe("both_fixtures");
	});

	it("says nothing about fixtures for an app with no rule that reads one", () => {
		/* Same rule `logo_refs` follows: CommCare HQ's in-place update is an
		 * overlay merge, so emitting a value here would overwrite a choice
		 * somebody made over there on every republish. A fixed-place owner
		 * prints a literal and reads no instance, so it needs nothing. */
		expect(expandDoc(fixedOwnerDoc()).location_fixture_restore).toBeUndefined();
	});

	it.each(["ccz", "hq-json", "hq-upload"] as const)(
		"lets an owner beneath the current case owner export as %s",
		async (mode) => {
			/* Nothing in this expression is Nova's to translate. It prints
			 * level CODES, which a publish puts on the project space as
			 * `location_type_code`, and matches them against the case's own
			 * `owner_id`, which is CommCare HQ's value at runtime; the
			 * `locations` fixture it reads is CommCare's own restore
			 * fixture on every mode. Refusing it would refuse an app that
			 * works. */
			const result = await prepareExportBoundary({
				mode,
				access: ACCESS,
				doc: reverseOwnerDoc(),
				compiledAtSeq: 16,
				attachmentTarget: null,
			});

			const locationFindings = result.ok
				? []
				: result.violations.filter(
						(candidate) =>
							candidate.code === "LOCATION_OWNER_EXPORT_NOT_ACTIVE",
					);
			expect(locationFindings).toEqual([]);
		},
	);

	it("prepares carrier-bearing ccz exports with the budget-checked lookup wire", async () => {
		vi.mocked(getLookupFixtureData).mockResolvedValue(
			carrierFixtureSnapshot() as never,
		);

		const result = await prepareExportBoundary({
			mode: "ccz",
			access: ACCESS,
			doc: lookupCarrierDoc(),
			compiledAtSeq: 15,
			attachmentTarget: null,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected prepared ccz export");
		const wire = result.prepared.lookupWire;
		expect(wire).toBeDefined();
		expect(wire?.naming.tableFor(CARRIER_TABLE).fixtureId).toBe(
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
			attachmentTarget: null,
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
			attachmentTarget: null,
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
