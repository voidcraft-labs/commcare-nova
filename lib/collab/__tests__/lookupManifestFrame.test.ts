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
					tables: [{ ...MANIFEST.tables[0], tag: "not-valid" }],
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

	it("retains the latest valid manifest for immediate late-subscriber replay", () => {
		const broker = createLookupManifestBroker();
		broker.dispatch(JSON.stringify(MANIFEST));
		broker.dispatch("not json");

		const late = vi.fn<(manifest: LookupManifest | null) => void>();
		broker.subscribe(late);
		expect(late).toHaveBeenCalledOnce();
		expect(late).toHaveBeenCalledWith(MANIFEST);
	});

	it("keeps a latched Project manifest forward-only within one runtime", () => {
		const broker = createLookupManifestBroker();
		const current = vi.fn<(manifest: LookupManifest | null) => void>();
		broker.subscribe(current);
		broker.dispatch(JSON.stringify(MANIFEST));

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
		broker.dispatch(JSON.stringify(lower));
		broker.dispatch(JSON.stringify(foreign));
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
		broker.dispatch(JSON.stringify(equal));
		broker.dispatch(JSON.stringify(newer));
		expect(current).toHaveBeenCalledTimes(3);

		const late = vi.fn<(manifest: LookupManifest | null) => void>();
		broker.subscribe(late);
		expect(late).toHaveBeenCalledWith(newer);
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
		broker.dispatch(JSON.stringify(MANIFEST));
		expect(failing).toHaveBeenCalledOnce();
		expect(healthy).toHaveBeenCalledTimes(2);

		unsubscribeHealthy();
		unsubscribeHealthy();
		broker.dispatch(JSON.stringify(MANIFEST));
		expect(healthy).toHaveBeenCalledTimes(2);
	});
});
