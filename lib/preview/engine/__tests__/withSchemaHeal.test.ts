/**
 * `withSchemaHeal` — the point-of-use self-heal for a case-store call
 * that hits `SchemaNotSyncedError`. The contract under test:
 *
 *   - only `SchemaNotSyncedError` triggers a heal; every other throw
 *     passes through untouched (no Firestore read);
 *   - a heal re-materializes from the app's PERSISTED blueprint (not a
 *     caller-supplied copy) and retries the call exactly once;
 *   - a foreign-owned or missing app, or a failing materialize, rethrows
 *     the ORIGINAL error so the typed `schema-not-synced` arm stays the
 *     honest backstop;
 *   - a retry that fails again surfaces its own error — never a loop.
 *
 * `schemaHealingCaseStore` scopes that heal to ONE store operation at a
 * time, which is what makes a multi-write submission retry-safe: the
 * partial-sync test below drives a followup whose writes span three
 * separate transactions and proves only the write that threw re-runs.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CaseStore } from "@/lib/case-store";
import { SchemaNotSyncedError } from "@/lib/case-store/errors";

const { loadAppMock, materializeMock } = vi.hoisted(() => ({
	loadAppMock: vi.fn(),
	materializeMock: vi.fn(),
}));

vi.mock("@/lib/db/apps", () => ({ loadApp: loadAppMock }));
vi.mock("@/lib/db/materializeCaseStoreSchemas", () => ({
	materializeCaseStoreSchemas: materializeMock,
}));

import {
	applyFollowupMutation,
	schemaHealingCaseStore,
	withSchemaHeal,
} from "../caseDataBindingHelpers";

const ARGS = { appId: "app-1", userId: "user-1" };
const BLUEPRINT = { caseTypes: [{ name: "patient", properties: [] }] };
const notSynced = () => new SchemaNotSyncedError("app-1", "patient");

describe("withSchemaHeal", () => {
	beforeEach(() => {
		loadAppMock.mockReset();
		materializeMock.mockReset();
	});

	it("returns the first attempt's result with no heal machinery on the happy path", async () => {
		const run = vi.fn().mockResolvedValue("rows");
		await expect(withSchemaHeal(ARGS, run)).resolves.toBe("rows");
		expect(run).toHaveBeenCalledTimes(1);
		expect(loadAppMock).not.toHaveBeenCalled();
	});

	it("passes a non-schema error through without healing", async () => {
		const boom = new Error("postgres down");
		const run = vi.fn().mockRejectedValue(boom);
		await expect(withSchemaHeal(ARGS, run)).rejects.toBe(boom);
		expect(loadAppMock).not.toHaveBeenCalled();
	});

	it("materializes from the persisted blueprint and retries once on SchemaNotSyncedError", async () => {
		loadAppMock.mockResolvedValue({ owner: "user-1", blueprint: BLUEPRINT });
		materializeMock.mockResolvedValue(undefined);
		const run = vi
			.fn()
			.mockRejectedValueOnce(notSynced())
			.mockResolvedValueOnce("rows");

		await expect(withSchemaHeal(ARGS, run)).resolves.toBe("rows");
		expect(materializeMock).toHaveBeenCalledWith({
			appId: "app-1",
			userId: "user-1",
			blueprint: BLUEPRINT,
		});
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("rethrows the ORIGINAL error when the app is missing or foreign-owned", async () => {
		const original = notSynced();
		loadAppMock.mockResolvedValue({ owner: "someone-else", blueprint: {} });
		const run = vi.fn().mockRejectedValue(original);

		await expect(withSchemaHeal(ARGS, run)).rejects.toBe(original);
		expect(materializeMock).not.toHaveBeenCalled();
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("rethrows the ORIGINAL error when the materialize itself fails", async () => {
		const original = notSynced();
		loadAppMock.mockResolvedValue({ owner: "user-1", blueprint: BLUEPRINT });
		materializeMock.mockRejectedValue(new Error("postgres still down"));
		const run = vi.fn().mockRejectedValue(original);

		await expect(withSchemaHeal(ARGS, run)).rejects.toBe(original);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("retries exactly once — a second SchemaNotSyncedError surfaces, never loops", async () => {
		loadAppMock.mockResolvedValue({ owner: "user-1", blueprint: BLUEPRINT });
		materializeMock.mockResolvedValue(undefined);
		const second = notSynced();
		const run = vi
			.fn()
			.mockRejectedValueOnce(notSynced())
			.mockRejectedValueOnce(second);

		await expect(withSchemaHeal(ARGS, run)).rejects.toBe(second);
		expect(run).toHaveBeenCalledTimes(2);
		expect(materializeMock).toHaveBeenCalledTimes(1);
	});
});

describe("schemaHealingCaseStore — heal granularity is the individual store write", () => {
	beforeEach(() => {
		loadAppMock.mockReset();
		materializeMock.mockReset();
	});

	it("a followup whose second child hits the partial-sync shape resumes — child #1 is NOT re-inserted", async () => {
		// The heal's own canonical producer is exactly this: a new case type
		// whose drain-end materialize failed while the old types stayed
		// synced. A followup creating children of two types then lands the
		// primary update and child #1 (synced types, separate transactions),
		// throws on child #2's validator acquisition (no schema row, nothing
		// written), heals, and must retry ONLY child #2 — a dispatch-level
		// re-run would duplicate child #1 as a real row in the user's case
		// store.
		loadAppMock.mockResolvedValue({
			owner: "user-1",
			blueprint: { caseTypes: [{ name: "newborn", properties: [] }] },
		});
		materializeMock.mockResolvedValue(undefined);

		const update = vi.fn().mockResolvedValue(undefined);
		const insert = vi
			.fn()
			.mockResolvedValueOnce({ caseId: "child-1" })
			.mockRejectedValueOnce(new SchemaNotSyncedError("app-1", "newborn"))
			.mockResolvedValueOnce({ caseId: "child-2" });
		const store = schemaHealingCaseStore(
			{ update, insert } as unknown as CaseStore,
			ARGS,
		);

		const result = await applyFollowupMutation(store, {
			appId: "app-1",
			mutation: {
				kind: "followup",
				caseId: "mother-1",
				patch: { properties: { visited: "yes" } },
				children: [
					{
						caseType: "visit",
						caseName: "Visit 1",
						properties: {},
						parentCaseId: "mother-1",
					},
					{
						caseType: "newborn",
						caseName: "Baby 1",
						properties: {},
						parentCaseId: "mother-1",
					},
				],
			},
		});

		// The primary update landed once and was never re-run.
		expect(update).toHaveBeenCalledTimes(1);
		// Three inserts total: child #1 once, child #2 twice (throw + healed
		// retry) — never a duplicate of child #1.
		expect(insert).toHaveBeenCalledTimes(3);
		const insertedTypes = insert.mock.calls.map(
			([args]) => (args as { row: { case_type: string } }).row.case_type,
		);
		expect(insertedTypes).toEqual(["visit", "newborn", "newborn"]);
		expect(materializeMock).toHaveBeenCalledTimes(1);
		// Partial progress RESUMED: both children report exactly one id each.
		expect(result).toEqual({
			caseId: "mother-1",
			childCaseIds: ["child-1", "child-2"],
		});
	});
});
