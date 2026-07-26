import { describe, expect, it } from "vitest";
import {
	assertStrictCaptureMaintenance,
	type CaptureMaintenanceSummary,
	readCaptureCleanupMode,
} from "../captureCleanupGate";

const clean: CaptureMaintenanceSummary = {
	prepared: 2,
	discarded: 1,
	preparationFailures: 0,
	supersededPreparations: 1,
	expiredRows: 3,
	transitionedExpiredRows: 2,
	objectDeleteFailures: 0,
};

describe("capture cleanup release gate", () => {
	it("keeps scheduler as the explicit best-effort default", () => {
		expect(readCaptureCleanupMode(undefined)).toBe("scheduler");
		expect(readCaptureCleanupMode("scheduler")).toBe("scheduler");
		expect(readCaptureCleanupMode("strict")).toBe("strict");
		expect(() => readCaptureCleanupMode("best-effort")).toThrow(
			"must be either",
		);
	});

	it("accepts a clean strict run, including harmless generation supersession", () => {
		expect(() => assertStrictCaptureMaintenance(clean)).not.toThrow();
	});

	it.each([
		["preparation/discard", { ...clean, preparationFailures: 1 }],
		["object deletion", { ...clean, objectDeleteFailures: 1 }],
	])("fails the deploy on any %s failure", (_label, summary) => {
		expect(() => assertStrictCaptureMaintenance(summary)).toThrow(
			"Strict capture maintenance failed",
		);
	});
});
