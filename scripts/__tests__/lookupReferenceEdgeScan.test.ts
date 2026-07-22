import { describe, expect, it } from "vitest";
import {
	EMPTY_LOOKUP_REFERENCE_TARGETS,
	normalizeLookupReferenceTargetSet,
	type LookupReferenceTargetSet,
} from "@/lib/doc/lookupReferences";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import {
	buildLookupReferenceScanReport,
	compareLookupReferenceTargetSets,
	type LookupReferenceScanApp,
	type LookupReferenceScanObservation,
	renderLookupReferenceScanReport,
} from "../lib/lookupReferenceEdgeScan";

const TABLE_A = lookupTableIdSchema.parse(
	"018f0f43-7b7c-7abc-8def-0123456789a1",
);
const TABLE_B = lookupTableIdSchema.parse(
	"018f0f43-7b7c-7abc-8def-0123456789b2",
);
const TABLE_C = lookupTableIdSchema.parse(
	"018f0f43-7b7c-7abc-8def-0123456789c3",
);
const COLUMN_A = lookupColumnIdSchema.parse(
	"018f0f43-7b7c-7abc-9def-0123456789a1",
);
const COLUMN_B = lookupColumnIdSchema.parse(
	"018f0f43-7b7c-7abc-9def-0123456789b2",
);

function app(
	appId: string,
	partial: Partial<LookupReferenceScanApp> = {},
): LookupReferenceScanApp {
	return {
		appId,
		projectId: "project-a",
		appName: `App ${appId}`,
		deletedAt: null,
		...partial,
	};
}

function compared(
	appId: string,
	structural: LookupReferenceTargetSet,
	stored: LookupReferenceTargetSet,
	partial: Partial<LookupReferenceScanApp> = {},
): LookupReferenceScanObservation {
	return {
		app: app(appId, partial),
		structural: { kind: "ok", targets: structural },
		stored: { kind: "ok", targets: stored },
	};
}

describe("lookup reference edge scan comparison", () => {
	it("treats empty structural and stored sets as a clean zero-carrier scan", () => {
		const report = buildLookupReferenceScanReport([
			compared(
				"app-empty",
				EMPTY_LOOKUP_REFERENCE_TARGETS,
				EMPTY_LOOKUP_REFERENCE_TARGETS,
			),
		]);

		expect(report).toMatchObject({
			scannedApps: 1,
			comparedApps: 1,
			cleanApps: 1,
			mismatches: [],
			structuralOnlyApps: 0,
			storedOnlyApps: 0,
			structuralOnlyTargets: 0,
			storedOnlyTargets: 0,
			exitCode: 0,
		});
		expect(renderLookupReferenceScanReport(report)).toContain(
			"CLEAN: every assembled blueprint's structural lookup targets exactly match",
		);
	});

	it("reports a structural-only column without falsely reporting its shared parent table", () => {
		const structural = normalizeLookupReferenceTargetSet({
			columnTargets: [{ tableId: TABLE_A, columnId: COLUMN_A }],
		});
		const stored = normalizeLookupReferenceTargetSet({ tableIds: [TABLE_A] });

		expect(compareLookupReferenceTargetSets(structural, stored)).toEqual({
			structuralOnly: {
				tableIds: [],
				columnTargets: [{ tableId: TABLE_A, columnId: COLUMN_A }],
			},
			storedOnly: { tableIds: [], columnTargets: [] },
		});
		const report = buildLookupReferenceScanReport([
			compared("app-structural", structural, stored),
		]);
		expect(report.structuralOnlyApps).toBe(1);
		expect(report.structuralOnlyTargets).toBe(1);
		expect(report.exitCode).toBe(1);
	});

	it("reports complete stored-only table and column identities", () => {
		const stored = normalizeLookupReferenceTargetSet({
			columnTargets: [{ tableId: TABLE_B, columnId: COLUMN_B }],
		});
		const report = buildLookupReferenceScanReport([
			compared("app-stored", EMPTY_LOOKUP_REFERENCE_TARGETS, stored),
		]);

		expect(report.storedOnlyApps).toBe(1);
		expect(report.storedOnlyTargets).toBe(2);
		expect(report.mismatches[0]?.storedOnly).toEqual({
			tableIds: [TABLE_B],
			columnTargets: [{ tableId: TABLE_B, columnId: COLUMN_B }],
		});
		expect(renderLookupReferenceScanReport(report)).toContain(
			`column ${TABLE_B} / ${COLUMN_B}`,
		);
	});

	it("surfaces a stale source-Project edge returned by the app-wide reader", () => {
		const staleSourceTargets = normalizeLookupReferenceTargetSet({
			tableIds: [TABLE_A],
		});
		const report = buildLookupReferenceScanReport([
			compared(
				"app-moved",
				EMPTY_LOOKUP_REFERENCE_TARGETS,
				staleSourceTargets,
				{ projectId: "project-destination" },
			),
		]);
		const rendered = renderLookupReferenceScanReport(report);

		expect(report.mismatches[0]?.storedOnly.tableIds).toEqual([TABLE_A]);
		expect(rendered).toContain("app-moved (project-destination; live;");
		expect(rendered).toContain(`stored-only: 1 table(s), 0 column(s)`);
	});

	it("orders multiple apps and every target identity deterministically", () => {
		const unorderedStructural: LookupReferenceTargetSet = {
			tableIds: [TABLE_C, TABLE_A, TABLE_C],
			columnTargets: [
				{ tableId: TABLE_C, columnId: COLUMN_B },
				{ tableId: TABLE_A, columnId: COLUMN_A },
			],
		};
		const report = buildLookupReferenceScanReport([
			compared(
				"app-z",
				EMPTY_LOOKUP_REFERENCE_TARGETS,
				normalizeLookupReferenceTargetSet({ tableIds: [TABLE_B] }),
			),
			compared("app-a", unorderedStructural, EMPTY_LOOKUP_REFERENCE_TARGETS, {
				deletedAt: "2026-07-22T10:00:00.000Z",
			}),
		]);
		const rendered = renderLookupReferenceScanReport(report);

		expect(report.mismatches.map(({ appId }) => appId)).toEqual([
			"app-a",
			"app-z",
		]);
		expect(report.mismatches[0]?.structuralOnly.tableIds).toEqual([
			TABLE_A,
			TABLE_C,
		]);
		expect(rendered.indexOf("app-a")).toBeLessThan(rendered.indexOf("app-z"));
		expect(rendered).toContain("soft-deleted 2026-07-22T10:00:00.000Z");
		expect(rendered.indexOf(`table ${TABLE_A}`)).toBeLessThan(
			rendered.indexOf(`table ${TABLE_C}`),
		);
	});

	it("aggregates unassemblable apps and independent operational errors", () => {
		const observations: LookupReferenceScanObservation[] = [
			{
				app: app("app-broken-blueprint"),
				structural: {
					kind: "unassemblable",
					message: "invalid module membership",
				},
				stored: {
					kind: "error",
					stage: "read-stored-targets",
					message: "connection reset",
				},
			},
			{
				app: app("app-extractor-error"),
				structural: {
					kind: "error",
					stage: "extract-structural-targets",
					message: "duplicate registry slot",
				},
				stored: { kind: "ok", targets: EMPTY_LOOKUP_REFERENCE_TARGETS },
			},
		];
		const report = buildLookupReferenceScanReport(observations);

		expect(report).toMatchObject({
			scannedApps: 2,
			comparedApps: 0,
			cleanApps: 0,
			exitCode: 1,
		});
		expect(report.unassemblableApps).toHaveLength(1);
		expect(report.operationalErrors.map(({ stage }) => stage)).toEqual([
			"read-stored-targets",
			"extract-structural-targets",
		]);
		const rendered = renderLookupReferenceScanReport(report);
		expect(rendered).toContain("Unassemblable apps (1)");
		expect(rendered).toContain("Operational scan errors (2)");
		expect(rendered).toContain("connection reset");
		expect(rendered).toContain("duplicate registry slot");
	});

	it("returns nonzero for every failure class and zero only for a clean scan", () => {
		const mismatch = compared(
			"app-mismatch",
			normalizeLookupReferenceTargetSet({ tableIds: [TABLE_A] }),
			EMPTY_LOOKUP_REFERENCE_TARGETS,
		);
		const unassemblable: LookupReferenceScanObservation = {
			app: app("app-unassemblable"),
			structural: { kind: "unassemblable", message: "bad rows" },
			stored: { kind: "ok", targets: EMPTY_LOOKUP_REFERENCE_TARGETS },
		};
		const operational: LookupReferenceScanObservation = {
			app: app("app-error"),
			structural: { kind: "ok", targets: EMPTY_LOOKUP_REFERENCE_TARGETS },
			stored: {
				kind: "error",
				stage: "read-stored-targets",
				message: "sql unavailable",
			},
		};

		expect(buildLookupReferenceScanReport([]).exitCode).toBe(0);
		expect(buildLookupReferenceScanReport([mismatch]).exitCode).toBe(1);
		expect(buildLookupReferenceScanReport([unassemblable]).exitCode).toBe(1);
		expect(buildLookupReferenceScanReport([operational]).exitCode).toBe(1);
	});
});
