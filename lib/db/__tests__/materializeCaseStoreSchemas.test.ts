import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaseStore } from "@/lib/case-store";
import type { PersistableDoc } from "@/lib/domain";

const { withSchemaContext } = vi.hoisted(() => ({
	withSchemaContext: vi.fn(),
}));
vi.mock("@/lib/case-store", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/case-store")>()),
	withSchemaContext,
}));

import { materializeCaseStoreSchemas } from "../materializeCaseStoreSchemas";

const blueprint: PersistableDoc = {
	appId: "app",
	appName: "Materialize",
	connectType: null,
	caseTypes: ["a", "b", "c"].map((name) => ({ name, properties: [] })),
	modules: {},
	forms: {},
	fields: {},
	moduleOrder: [],
	formOrder: {},
	fieldOrder: {},
};
const emptyReport = {
	migrated: 0,
	reshaped: 0,
	retyped: 0,
	restored: 0,
	parkedIds: [],
	skipped: 0,
	failureReasons: [],
};
const applySchemaChange = vi.fn<CaseStore["applySchemaChange"]>();
const drain = vi.fn<() => Promise<void>>();

beforeEach(() => {
	vi.useFakeTimers();
	applySchemaChange.mockReset().mockResolvedValue(emptyReport);
	drain.mockReset().mockResolvedValue(undefined);
	withSchemaContext.mockReset().mockResolvedValue({
		applySchemaChange,
		drainPendingIndexConvergence: drain,
	});
});
afterEach(() => vi.useRealTimers());

describe("schema materialization orchestration", () => {
	it("threads one snapshot sequence into every authored and implicit type", async () => {
		await materializeCaseStoreSchemas({
			appId: "app",
			blueprint,
			syncedSeq: 12,
		});
		expect(
			applySchemaChange.mock.calls.map(([args]) => [
				args.caseType,
				args.syncedSeq,
			]),
		).toEqual([
			["a", 12],
			["b", 12],
			["c", 12],
			["commcare-user", 12],
		]);
	});

	it("leaves sequence admission unspecified when the caller has no snapshot sequence", async () => {
		await materializeCaseStoreSchemas({ appId: "app", blueprint });
		for (const [args] of applySchemaChange.mock.calls)
			expect(args).not.toHaveProperty("syncedSeq");
		expect(applySchemaChange.mock.calls).toHaveLength(4);
	});

	it("surfaces a deterministic failure without retrying or attempting later types", async () => {
		const fault = new Error("identifier collision");
		applySchemaChange.mockImplementation(async ({ caseType }) => {
			if (caseType === "b") throw fault;
			return emptyReport;
		});
		await expect(
			materializeCaseStoreSchemas({ appId: "app", blueprint }),
		).rejects.toBe(fault);
		expect(applySchemaChange.mock.calls.map(([args]) => args.caseType)).toEqual(
			["a", "b"],
		);
	});

	it("exhausts transient retries on one type and still materializes later types", async () => {
		applySchemaChange.mockImplementation(async ({ caseType }) => {
			if (caseType === "b")
				throw Object.assign(new Error("connection reset"), {
					code: "ECONNRESET",
				});
			return emptyReport;
		});
		const completed = expect(
			materializeCaseStoreSchemas({ appId: "app", blueprint }),
		).resolves.toBeUndefined();
		await vi.runAllTimersAsync();
		await completed;
		expect(applySchemaChange.mock.calls.map(([args]) => args.caseType)).toEqual(
			["a", "b", "b", "b", "c", "commcare-user"],
		);
	});

	it("retries a transient blip and completes each remaining type once", async () => {
		applySchemaChange.mockRejectedValueOnce(
			Object.assign(new Error("connection reset"), { code: "ECONNRESET" }),
		);
		const completed = expect(
			materializeCaseStoreSchemas({ appId: "app", blueprint }),
		).resolves.toBeUndefined();
		await vi.runAllTimersAsync();
		await completed;
		expect(applySchemaChange.mock.calls.map(([args]) => args.caseType)).toEqual(
			["a", "a", "b", "c", "commcare-user"],
		);
	});

	it("surfaces a pending-index drain failure before attempting schema writes", async () => {
		const fault = Object.assign(new Error("index drain unavailable"), {
			code: "ECONNRESET",
		});
		drain.mockRejectedValue(fault);
		await expect(
			materializeCaseStoreSchemas({ appId: "app", blueprint }),
		).rejects.toBe(fault);
		expect(applySchemaChange).not.toHaveBeenCalled();
	});
});
