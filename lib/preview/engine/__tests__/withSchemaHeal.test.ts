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
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SchemaNotSyncedError } from "@/lib/case-store/errors";

const { loadAppMock, materializeMock } = vi.hoisted(() => ({
	loadAppMock: vi.fn(),
	materializeMock: vi.fn(),
}));

vi.mock("@/lib/db/apps", () => ({ loadApp: loadAppMock }));
vi.mock("@/lib/db/materializeCaseStoreSchemas", () => ({
	materializeCaseStoreSchemas: materializeMock,
}));

import { withSchemaHeal } from "../caseDataBindingHelpers";

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
