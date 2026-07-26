import "server-only";

export type CaptureCleanupMode = "scheduler" | "strict";

export interface CaptureMaintenanceSummary {
	readonly prepared: number;
	readonly discarded: number;
	readonly preparationFailures: number;
	readonly supersededPreparations: number;
	readonly expiredRows: number;
	readonly transitionedExpiredRows: number;
	readonly objectDeleteFailures: number;
}

export function readCaptureCleanupMode(
	value = process.env.NOVA_CAPTURE_CLEANUP_MODE,
): CaptureCleanupMode {
	if (value === undefined || value.trim() === "" || value === "scheduler") {
		return "scheduler";
	}
	if (value === "strict") return "strict";
	throw new Error(
		"NOVA_CAPTURE_CLEANUP_MODE must be either `scheduler` or `strict`.",
	);
}

/** The scheduled worker records and retries partial failures. The pre-traffic
 * execution is a release gate, so the exact same counters fail the build. */
export function assertStrictCaptureMaintenance(
	summary: CaptureMaintenanceSummary,
): void {
	if (summary.preparationFailures === 0 && summary.objectDeleteFailures === 0) {
		return;
	}
	throw new Error(
		`Strict capture maintenance failed: preparation/discard failures=${summary.preparationFailures}, object-delete failures=${summary.objectDeleteFailures}.`,
	);
}
