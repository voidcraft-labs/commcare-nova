/** Mocked persistence boundary: retry eligibility, ordering, identity and error
 * propagation. Database rollback and persisted effects belong to native tests. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import type { CaseStore } from "@/lib/case-store";
import {
	CasePropertiesValidationError,
	SchemaNotSyncedError,
} from "@/lib/case-store/errors";
import { assertAdmittedPreviewDoc } from "../../__tests__/fixtures/admittedDoc";

const { drainPendingMock, loadAppMock, materializeMock } = vi.hoisted(() => ({
	drainPendingMock: vi.fn(),
	loadAppMock: vi.fn(),
	materializeMock: vi.fn(),
}));
vi.mock("@/lib/db/apps", () => ({ loadApp: loadAppMock }));
vi.mock("@/lib/db/materializeCaseStoreSchemas", () => ({
	drainPendingCaseSchemaIndexes: drainPendingMock,
	materializeCaseStoreSchemas: materializeMock,
}));

import {
	schemaHealingCaseStore,
	withSchemaHeal,
} from "../caseDataBindingHelpers";

const ARGS = { appId: "app-1" };
const BLUEPRINT = assertAdmittedPreviewDoc(
	buildDoc({
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListOnly: true,
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [],
			},
		],
	}),
);
const notSynced = () => new SchemaNotSyncedError("app-1", "patient");
const staleDrift = () =>
	new CasePropertiesValidationError("app-1", "patient", [
		{ path: "", message: "Unknown phone", additionalProperty: "phone" },
	]);
const genuineInvalid = () =>
	new CasePropertiesValidationError("app-1", "patient", [
		{ path: "/age", message: "must be integer" },
	]);
beforeEach(() => vi.resetAllMocks());

function persistedSnapshot() {
	loadAppMock.mockResolvedValue({ blueprint: BLUEPRINT, mutation_seq: 8 });
	materializeMock.mockResolvedValue(undefined);
}

describe("withSchemaHeal", () => {
	it("awaits pending index convergence before starting the operation", async () => {
		const pending = Promise.withResolvers<void>();
		drainPendingMock.mockReturnValue(pending.promise);
		const run = vi.fn().mockResolvedValue("rows");
		const result = withSchemaHeal(ARGS, run);
		try {
			expect(drainPendingMock).toHaveBeenCalledWith("app-1");
			expect(run).not.toHaveBeenCalled();
		} finally {
			pending.resolve();
			await expect(result).resolves.toBe("rows");
		}
		expect(run).toHaveBeenCalledOnce();
		expect(loadAppMock).not.toHaveBeenCalled();
	});

	it("continues the operation when best-effort index convergence fails", async () => {
		drainPendingMock.mockRejectedValue(
			new Error("index convergence unavailable"),
		);
		const run = vi.fn().mockResolvedValue("rows");
		await expect(withSchemaHeal(ARGS, run)).resolves.toBe("rows");
		expect(run).toHaveBeenCalledOnce();
		expect(loadAppMock).not.toHaveBeenCalled();
	});

	it.each([new Error("connection unavailable"), genuineInvalid()])(
		"propagates a non-drift error without reading or materializing: %s",
		async (error) => {
			const run = vi.fn().mockRejectedValue(error);
			await expect(withSchemaHeal(ARGS, run)).rejects.toBe(error);
			expect(run).toHaveBeenCalledOnce();
			expect(loadAppMock).not.toHaveBeenCalled();
			expect(materializeMock).not.toHaveBeenCalled();
		},
	);

	describe.each([notSynced, staleDrift])(
		"a recoverable schema signal",
		(failure) => {
			it("loads one snapshot, awaits its materialization, then retries with its sequence", async () => {
				persistedSnapshot();
				const materialized = Promise.withResolvers<void>();
				materializeMock.mockReturnValue(materialized.promise);
				const firstAttempt = failure();
				const run = vi
					.fn()
					.mockRejectedValueOnce(firstAttempt)
					.mockResolvedValueOnce("rows");
				const result = withSchemaHeal(ARGS, run);
				try {
					await vi.waitFor(() =>
						expect(materializeMock).toHaveBeenCalledOnce(),
					);
					expect(run).toHaveBeenCalledOnce();
					expect(materializeMock).toHaveBeenCalledWith({
						appId: "app-1",
						blueprint: BLUEPRINT,
						syncedSeq: 8,
					});
				} finally {
					materialized.resolve();
					await expect(result).resolves.toBe("rows");
				}
				expect(run).toHaveBeenCalledTimes(2);
				expect(loadAppMock).toHaveBeenCalledOnce();
				expect(drainPendingMock).toHaveBeenCalledOnce();
			});

			it.each(["missing", "load-failure", "materialize-failure"])(
				"preserves the original error when recovery ends at %s",
				async (mode) => {
					const original = failure();
					persistedSnapshot();
					if (mode === "missing") loadAppMock.mockResolvedValue(null);
					if (mode === "load-failure")
						loadAppMock.mockRejectedValue(new Error("load unavailable"));
					if (mode === "materialize-failure")
						materializeMock.mockRejectedValue(
							new Error("materialize unavailable"),
						);
					const run = vi.fn().mockRejectedValue(original);
					await expect(withSchemaHeal(ARGS, run)).rejects.toBe(original);
					expect(run).toHaveBeenCalledOnce();
					if (mode !== "materialize-failure")
						expect(materializeMock).not.toHaveBeenCalled();
				},
			);

			it("surfaces the retry's own failure after one recovery attempt", async () => {
				persistedSnapshot();
				const second = failure();
				const run = vi
					.fn()
					.mockRejectedValueOnce(failure())
					.mockRejectedValueOnce(second);
				await expect(withSchemaHeal(ARGS, run)).rejects.toBe(second);
				expect(run).toHaveBeenCalledTimes(2);
				expect(materializeMock).toHaveBeenCalledOnce();
			});
		},
	);
});

describe("schemaHealingCaseStore adapter", () => {
	it("retries a grouped read with the same request", async () => {
		persistedSnapshot();
		const settled = { groups: [], totalGroups: 0, totalRows: 0 };
		const queryGrouped = vi
			.fn<CaseStore["queryGrouped"]>()
			.mockRejectedValueOnce(notSynced())
			.mockResolvedValueOnce(settled);
		const store = schemaHealingCaseStore(
			{ queryGrouped } as unknown as CaseStore,
			ARGS,
		);
		const request = {
			appId: "app-1",
			caseType: "patient",
			indexIdentifier: "parent",
			groupOffset: 0,
			groupLimit: 50,
		};
		await expect(store.queryGrouped(request)).resolves.toEqual(settled);
		expect(queryGrouped.mock.calls.map(([args]) => args)).toEqual([
			request,
			request,
		]);
	});

	it("retries the identical complete submission envelope at the store boundary", async () => {
		persistedSnapshot();
		const settled = {
			primaryCaseIds: ["patient-1"],
			createdChildren: [],
			operations: [],
			blueprintDigest: "0".repeat(64),
		};
		const applySubmission = vi
			.fn<CaseStore["applySubmission"]>()
			.mockRejectedValueOnce(notSynced())
			.mockResolvedValueOnce(settled);
		const store = schemaHealingCaseStore(
			{ applySubmission } as unknown as CaseStore,
			ARGS,
		);
		const envelope: Parameters<CaseStore["applySubmission"]>[0] = {
			appId: "app-1",
			ordinary: {
				kind: "registration",
				primary: { caseType: "patient", caseName: "Ada", properties: {} },
				children: [],
			},
			submissionReceipt: {
				entryKey: "10000000-0000-4000-8000-000000000002",
				formUuid: testUuid("10000000-0000-4000-8000-000000000001"),
				expectedAppMutationSeq: 8,
				blueprintDigest: "0".repeat(64),
				requestDigest: "0".repeat(64),
			},
		};
		await expect(store.applySubmission(envelope)).resolves.toBe(settled);
		expect(applySubmission).toHaveBeenCalledTimes(2);
		expect(applySubmission.mock.calls[0]?.[0]).toBe(envelope);
		expect(applySubmission.mock.calls[1]?.[0]).toBe(envelope);
	});
});
