import { describe, expect, it, vi } from "vitest";
import {
	createLookupManifestBroker,
	parseLookupManifestFrame,
} from "@/lib/collab/lookupManifestFrame";
import type { LookupManifest } from "@/lib/lookup/types";

const MANIFEST = {
	projectId: "project-1",
	projectRevision: "17",
	tables: [
		{
			id: "01890f45-0000-7000-8000-000000000001",
			name: "Facilities",
			tag: "facilities",
			columnCount: 2,
			rowCount: 3,
			dataBytes: 128,
			definitionRevision: "12",
			rowsRevision: "17",
			tableRevision: "17",
		},
	],
};

describe("lookup manifest stream frames", () => {
	it("parses the exact full-manifest wire without rounding revisions", () => {
		const exact = {
			...MANIFEST,
			projectRevision: "9223372036854775807",
			tables: [
				{
					...MANIFEST.tables[0],
					definitionRevision: "9223372036854775806",
					rowsRevision: "9223372036854775807",
					tableRevision: "9223372036854775807",
				},
			],
		};

		expect(parseLookupManifestFrame(JSON.stringify(exact))).toEqual(exact);
	});

	it("relays tables beyond one edit and keeps protected source counts unavailable", () => {
		const wide = {
			...MANIFEST.tables[0],
			columnCount: 300,
			rowCount: 6000,
			dataBytes: 9000000,
		};
		const hq = {
			server: "production",
			domain: "demo",
			remoteId: "r",
			managedBy: "commcare-hq",
			source: {
				inventory: "unavailable",
				distribution: "assigned",
				indexEvidence: "unobserved",
			},
			broughtInAt: "2026-01-01T00:00:00Z",
			takenOverAt: null,
			takenOverBy: null,
		};
		const frame = (table: unknown) =>
			parseLookupManifestFrame(
				JSON.stringify({ ...MANIFEST, tables: [table] }),
			);
		expect(frame(wide)?.tables[0]).toEqual(wide);
		expect(frame({ ...wide, hq })).toBeNull();
		expect(
			frame({ ...wide, hq, rowCount: null, dataBytes: null })?.tables[0]
				.rowCount,
		).toBeNull();
		expect(frame({ ...wide, columnCount: 0 })?.tables[0].columnCount).toBe(0);
	});

	it("rejects malformed JSON, numeric revisions, and inconsistent clocks", () => {
		expect(parseLookupManifestFrame("not json")).toBeNull();
		expect(
			parseLookupManifestFrame(
				JSON.stringify({ ...MANIFEST, projectRevision: 17 }),
			),
		).toBeNull();
		expect(
			parseLookupManifestFrame(
				JSON.stringify({
					...MANIFEST,
					projectRevision: "16",
				}),
			),
		).toBeNull();
		expect(
			parseLookupManifestFrame(
				JSON.stringify({
					...MANIFEST,
					tables: [
						{
							...MANIFEST.tables[0],
							tableRevision: "12",
						},
					],
				}),
			),
		).toBeNull();
	});

	it("rejects noncanonical metadata and duplicate table identity", () => {
		expect(
			parseLookupManifestFrame(
				JSON.stringify({
					...MANIFEST,
					tables: [{ ...MANIFEST.tables[0], name: " Facilities " }],
				}),
			),
		).toBeNull();
		expect(
			parseLookupManifestFrame(
				JSON.stringify({
					...MANIFEST,
					tables: [{ ...MANIFEST.tables[0], tag: "9-not-valid" }],
				}),
			),
		).toBeNull();

		const secondTable = {
			...MANIFEST.tables[0],
			id: "01890f45-0000-7000-8000-000000000002",
			name: "Districts",
			tag: "districts",
		};
		expect(
			parseLookupManifestFrame(
				JSON.stringify({
					...MANIFEST,
					tables: [
						MANIFEST.tables[0],
						{ ...secondTable, id: MANIFEST.tables[0].id },
					],
				}),
			),
		).toBeNull();
		expect(
			parseLookupManifestFrame(
				JSON.stringify({
					...MANIFEST,
					tables: [
						MANIFEST.tables[0],
						{ ...secondTable, tag: MANIFEST.tables[0].tag },
					],
				}),
			),
		).toBeNull();
	});

	it("carries where a table came from in CommCare HQ, and only for such a table", () => {
		const hq = {
			server: "production",
			domain: "district-health",
			remoteId: "hq-table-1",
			managedBy: "commcare-hq",
			broughtInAt: "2026-11-01T09:30:00.000Z",
			takenOverAt: null,
			takenOverBy: null,
		};
		const managed = {
			...MANIFEST,
			tables: [{ ...MANIFEST.tables[0], hq }],
		};
		expect(parseLookupManifestFrame(JSON.stringify(managed))).toEqual(managed);

		const plain = parseLookupManifestFrame(JSON.stringify(MANIFEST));
		expect(plain?.tables[0]).not.toHaveProperty("hq");

		for (const malformed of [
			{ ...hq, managedBy: "someone-else" },
			{ ...hq, domain: "" },
			{ ...hq, broughtInAt: "yesterday" },
			{ ...hq, takenOverAt: "2026-11-03T00:00:00.000Z", takenOverBy: "" },
			/* The day of the last refresh moves with no revision, so a frame
			 * never carries it, nor the gone columns, which a manifest can't
			 * know. */
			{ ...hq, refreshedAt: "2026-11-02T10:00:00.000Z" },
			{ ...hq, goneColumnIds: [] },
			{ ...hq, extra: true },
		]) {
			expect(
				parseLookupManifestFrame(
					JSON.stringify({
						...MANIFEST,
						tables: [{ ...MANIFEST.tables[0], hq: malformed }],
					}),
				),
			).toBeNull();
		}
	});

	it("signals malformed current pages instead of silently retaining stale data", () => {
		const broker = createLookupManifestBroker();
		expect(broker.dispatch(JSON.stringify(MANIFEST))).toBe(true);
		expect(broker.dispatch("not json")).toBe(false);

		const late = vi.fn<(manifest: LookupManifest | null) => void>();
		broker.subscribe(late);
		expect(late).toHaveBeenCalledOnce();
		expect(late).toHaveBeenCalledWith(MANIFEST);
	});

	it("keeps a latched Project manifest forward-only within one runtime", () => {
		const broker = createLookupManifestBroker();
		const current = vi.fn<(manifest: LookupManifest | null) => void>();
		broker.subscribe(current);
		expect(broker.dispatch(JSON.stringify(MANIFEST))).toBe(true);

		const lower = {
			projectId: MANIFEST.projectId,
			projectRevision: "16",
			tables: [],
		};
		const foreign = {
			projectId: "project-2",
			projectRevision: "18",
			tables: [],
		};
		expect(broker.dispatch(JSON.stringify(lower))).toBe(false);
		expect(broker.dispatch(JSON.stringify(foreign))).toBe(false);
		expect(current).toHaveBeenCalledOnce();

		const equal = {
			projectId: MANIFEST.projectId,
			projectRevision: MANIFEST.projectRevision,
			tables: [],
		};
		const newer = {
			projectId: MANIFEST.projectId,
			projectRevision: "18",
			tables: [],
		};
		expect(broker.dispatch(JSON.stringify(equal))).toBe(false);
		expect(broker.dispatch(JSON.stringify(newer))).toBe(true);
		expect(current).toHaveBeenCalledTimes(2);

		const late = vi.fn<(manifest: LookupManifest | null) => void>();
		broker.subscribe(late);
		expect(late).toHaveBeenCalledWith(newer);
	});

	it("accepts an identical equal-revision refetch without duplicate fanout", () => {
		const broker = createLookupManifestBroker();
		const current = vi.fn<(manifest: LookupManifest | null) => void>();
		broker.subscribe(current);
		expect(broker.install(MANIFEST)).toBe(true);
		expect(broker.install(MANIFEST)).toBe(true);
		expect(current).toHaveBeenCalledExactlyOnceWith(MANIFEST);
	});

	it("clears subscribers and permits a new Project lineage after reset", () => {
		const broker = createLookupManifestBroker();
		const current = vi.fn<(manifest: LookupManifest | null) => void>();
		broker.subscribe(current);
		broker.dispatch(JSON.stringify(MANIFEST));

		broker.reset();
		broker.reset();
		expect(current).toHaveBeenNthCalledWith(1, MANIFEST);
		expect(current).toHaveBeenNthCalledWith(2, null);
		expect(current).toHaveBeenCalledTimes(2);

		const late = vi.fn<(manifest: LookupManifest | null) => void>();
		broker.subscribe(late);
		expect(late).not.toHaveBeenCalled();

		const destination = {
			projectId: "project-2",
			projectRevision: "1",
			tables: [],
		};
		broker.dispatch(JSON.stringify(destination));
		expect(current).toHaveBeenLastCalledWith(destination);
		expect(late).toHaveBeenCalledExactlyOnceWith(destination);
	});

	it("isolates subscriber faults and makes unsubscribe idempotent", () => {
		const broker = createLookupManifestBroker();
		const failing = vi.fn<(manifest: LookupManifest | null) => void>(() => {
			throw new Error("consumer failed");
		});
		const healthy = vi.fn<(manifest: LookupManifest | null) => void>();
		const unsubscribeFailing = broker.subscribe(failing);
		const unsubscribeHealthy = broker.subscribe(healthy);

		broker.dispatch(JSON.stringify(MANIFEST));
		expect(failing).toHaveBeenCalledOnce();
		expect(healthy).toHaveBeenCalledOnce();

		unsubscribeFailing();
		unsubscribeFailing();
		broker.dispatch(JSON.stringify({ ...MANIFEST, projectRevision: "18" }));
		expect(failing).toHaveBeenCalledOnce();
		expect(healthy).toHaveBeenCalledTimes(2);

		unsubscribeHealthy();
		unsubscribeHealthy();
		broker.dispatch(JSON.stringify({ ...MANIFEST, projectRevision: "19" }));
		expect(healthy).toHaveBeenCalledTimes(2);
	});

	it("notifies every subscriber then propagates a tenant-boundary reset failure", () => {
		const broker = createLookupManifestBroker();
		const healthy = vi.fn<(manifest: LookupManifest | null) => void>();
		broker.subscribe((manifest) => {
			if (manifest === null) throw new Error("retained old Project");
		});
		broker.subscribe(healthy);
		broker.dispatch(JSON.stringify(MANIFEST));

		expect(() => broker.reset()).toThrow(AggregateError);
		expect(healthy).toHaveBeenLastCalledWith(null);

		const late = vi.fn<(manifest: LookupManifest | null) => void>();
		broker.subscribe(late);
		expect(late).not.toHaveBeenCalled();
	});
});
