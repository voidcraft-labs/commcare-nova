/**
 * `withSchemaHeal` — the point-of-use self-heal for a case-store call
 * defeated by a schema row that no longer mirrors the persisted
 * blueprint. The contract under test:
 *
 *   - a heal triggers on a MISSING row (`SchemaNotSyncedError`) AND on a
 *     STALE row (`CasePropertiesValidationError` — a write carrying a
 *     property the row's older catalog lacks); every other throw passes
 *     through untouched (no Postgres read);
 *   - a heal re-materializes from the app's PERSISTED blueprint (not a
 *     caller-supplied copy) and passes its `mutation_seq` off the SAME
 *     snapshot as `syncedSeq` (so the monotone gate never pairs a later seq
 *     with an earlier schema), retrying the call exactly once;
 *   - a missing app, or a failing materialize, rethrows the ORIGINAL
 *     error so the typed `schema-not-synced` / `validation-failure` arm
 *     stays the honest backstop (Project membership is gated upstream at
 *     the Server Action, so the heal itself does no owner/membership
 *     re-check — the re-materialize is app-scoped schema sync);
 *   - a retry that fails again surfaces its own error — never a loop, and
 *     never a masked genuine validation failure.
 *
 * `schemaHealingCaseStore` scopes that heal to ONE store operation at a
 * time. For a form submission that ONE operation is the whole atomic
 * envelope (`applySubmission`, one Postgres transaction), so the heal
 * test below proves the retry re-runs the ENTIRE envelope once — nothing
 * partial can persist and no child can duplicate.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CaseStore } from "@/lib/case-store";
import {
	CasePropertiesValidationError,
	SchemaNotSyncedError,
} from "@/lib/case-store/errors";

const { loadAppMock, materializeMock } = vi.hoisted(() => ({
	loadAppMock: vi.fn(),
	materializeMock: vi.fn(),
}));

vi.mock("@/lib/db/apps", () => ({ loadApp: loadAppMock }));
vi.mock("@/lib/db/materializeCaseStoreSchemas", () => ({
	materializeCaseStoreSchemas: materializeMock,
}));

import {
	schemaHealingCaseStore,
	submissionEnvelopeArgs,
	withSchemaHeal,
} from "../caseDataBindingHelpers";
import type { SubmissionMutation } from "../caseDataBindingTypes";

const ARGS = { appId: "app-1" };
const BLUEPRINT = { caseTypes: [{ name: "patient", properties: [] }] };
const notSynced = () => new SchemaNotSyncedError("app-1", "patient");
// A STALE-row DRIFT failure: the row exists but its older catalog lacks a
// property the write carries — `additionalProperty` set is the structural
// signal the heal keys on. Each call is a fresh instance so identity
// assertions hold.
const staleDrift = () =>
	new CasePropertiesValidationError("app-1", "patient", [
		{
			path: "",
			message: "must NOT have additional property 'phone'",
			additionalProperty: "phone",
		},
	]);
// A GENUINE invalid-data failure (a type mismatch) — no `additionalProperty`,
// so it is NOT drift and must NOT trigger the heal.
const genuineInvalid = () =>
	new CasePropertiesValidationError("app-1", "patient", [
		{ path: "/age", message: "must be integer" },
	]);

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
		loadAppMock.mockResolvedValue({
			owner: "user-1",
			blueprint: BLUEPRINT,
			mutation_seq: 8,
		});
		materializeMock.mockResolvedValue(undefined);
		const run = vi
			.fn()
			.mockRejectedValueOnce(notSynced())
			.mockResolvedValueOnce("rows");

		await expect(withSchemaHeal(ARGS, run)).resolves.toBe("rows");
		expect(materializeMock).toHaveBeenCalledWith({
			appId: "app-1",
			blueprint: BLUEPRINT,
			syncedSeq: 8,
		});
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("rethrows the ORIGINAL error when the app is missing", async () => {
		const original = notSynced();
		loadAppMock.mockResolvedValue(null);
		const run = vi.fn().mockRejectedValue(original);

		await expect(withSchemaHeal(ARGS, run)).rejects.toBe(original);
		expect(materializeMock).not.toHaveBeenCalled();
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("rethrows the ORIGINAL error when the materialize itself fails", async () => {
		const original = notSynced();
		loadAppMock.mockResolvedValue({
			owner: "user-1",
			blueprint: BLUEPRINT,
			mutation_seq: 8,
		});
		materializeMock.mockRejectedValue(new Error("postgres still down"));
		const run = vi.fn().mockRejectedValue(original);

		await expect(withSchemaHeal(ARGS, run)).rejects.toBe(original);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("retries exactly once — a second SchemaNotSyncedError surfaces, never loops", async () => {
		loadAppMock.mockResolvedValue({
			owner: "user-1",
			blueprint: BLUEPRINT,
			mutation_seq: 8,
		});
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

describe("withSchemaHeal — stale schema row (CasePropertiesValidationError)", () => {
	beforeEach(() => {
		loadAppMock.mockReset();
		materializeMock.mockReset();
	});

	it("re-materializes from the persisted blueprint and retries once when a stale row trips additionalProperties", async () => {
		// The drift case: the row is present but built from a catalog that
		// predates the `phone` property, so the first write fails. The heal
		// re-syncs the row from the persisted blueprint and the retry lands.
		loadAppMock.mockResolvedValue({
			owner: "user-1",
			blueprint: BLUEPRINT,
			mutation_seq: 8,
		});
		materializeMock.mockResolvedValue(undefined);
		const run = vi
			.fn()
			.mockRejectedValueOnce(staleDrift())
			.mockResolvedValueOnce("rows");

		await expect(withSchemaHeal(ARGS, run)).resolves.toBe("rows");
		expect(materializeMock).toHaveBeenCalledWith({
			appId: "app-1",
			blueprint: BLUEPRINT,
			syncedSeq: 8,
		});
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("does NOT heal a non-drift validation failure (type/format) — surfaces immediately, no Postgres read", async () => {
		// A genuine invalid-data failure carries no `additionalProperty`, so
		// it is not drift: the heal must not fire. The error surfaces on the
		// first attempt with NO loadApp + re-materialize round-trip, and the
		// write is not retried.
		const invalid = genuineInvalid();
		const run = vi.fn().mockRejectedValue(invalid);

		await expect(withSchemaHeal(ARGS, run)).rejects.toBe(invalid);
		expect(loadAppMock).not.toHaveBeenCalled();
		expect(materializeMock).not.toHaveBeenCalled();
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("does NOT mask drift the re-materialize can't resolve (persisted blueprint also stale): the second error surfaces", async () => {
		// Drift the heal fires on, but the persisted blueprint is ALSO stale
		// (same failure left both the persisted blueprint and the row behind), so the
		// re-materialize regenerates the same schema and the retry fails
		// again. That second error propagates — one extra materialize +
		// retry, never a swallowed failure.
		loadAppMock.mockResolvedValue({
			owner: "user-1",
			blueprint: BLUEPRINT,
			mutation_seq: 8,
		});
		materializeMock.mockResolvedValue(undefined);
		const second = staleDrift();
		const run = vi
			.fn()
			.mockRejectedValueOnce(staleDrift())
			.mockRejectedValueOnce(second);

		await expect(withSchemaHeal(ARGS, run)).rejects.toBe(second);
		expect(run).toHaveBeenCalledTimes(2);
		expect(materializeMock).toHaveBeenCalledTimes(1);
	});

	it("rethrows the ORIGINAL validation error when the app is missing", async () => {
		const original = staleDrift();
		loadAppMock.mockResolvedValue(null);
		const run = vi.fn().mockRejectedValue(original);

		await expect(withSchemaHeal(ARGS, run)).rejects.toBe(original);
		expect(materializeMock).not.toHaveBeenCalled();
		expect(run).toHaveBeenCalledTimes(1);
	});
});

describe("schemaHealingCaseStore — the whole submission envelope is one healed operation", () => {
	beforeEach(() => {
		loadAppMock.mockReset();
		materializeMock.mockReset();
	});

	it("re-runs the WHOLE envelope on a missing-schema heal, landing each row exactly once", async () => {
		// The heal's own canonical producer: a followup creating a child of
		// a case type whose drain-end materialize failed, so its schema row
		// is missing. Because the whole submission is ONE store operation
		// (`applySubmission`) and ONE Postgres transaction, the first
		// attempt throws `SchemaNotSyncedError` with nothing partial
		// persisted; the heal re-materializes the persisted blueprint and
		// the retry re-runs the ENTIRE envelope once more. No child can
		// duplicate — a heal retry never resumes a half-applied envelope.
		loadAppMock.mockResolvedValue({
			owner: "user-1",
			blueprint: { caseTypes: [{ name: "newborn", properties: [] }] },
			mutation_seq: 8,
		});
		materializeMock.mockResolvedValue(undefined);

		const applySubmission = vi
			.fn()
			.mockRejectedValueOnce(new SchemaNotSyncedError("app-1", "newborn"))
			.mockResolvedValueOnce({
				primaryCaseId: "mother-1",
				childCaseIds: ["child-1"],
				operations: [],
			});
		const store = schemaHealingCaseStore(
			{ applySubmission } as unknown as CaseStore,
			ARGS,
		);

		const mutation: SubmissionMutation = {
			kind: "followup",
			caseId: "mother-1",
			patch: { properties: { visited: "yes" } },
			children: [
				{
					caseType: "newborn",
					caseName: "Baby 1",
					properties: {},
					parentCaseId: "mother-1",
				},
			],
		};
		const envelope = submissionEnvelopeArgs(mutation, "app-1");

		const result = await store.applySubmission(envelope);

		// Exactly two calls: the throw, then the whole-envelope retry — both
		// with the IDENTICAL envelope, proving nothing partial was resumed.
		expect(applySubmission).toHaveBeenCalledTimes(2);
		expect(applySubmission).toHaveBeenNthCalledWith(1, envelope);
		expect(applySubmission).toHaveBeenNthCalledWith(2, envelope);
		expect(materializeMock).toHaveBeenCalledTimes(1);
		expect(materializeMock).toHaveBeenCalledWith({
			appId: "app-1",
			blueprint: { caseTypes: [{ name: "newborn", properties: [] }] },
			syncedSeq: 8,
		});
		// The settled result carries the primary and its child exactly once.
		expect(result).toEqual({
			primaryCaseId: "mother-1",
			childCaseIds: ["child-1"],
			operations: [],
		});
	});
});
