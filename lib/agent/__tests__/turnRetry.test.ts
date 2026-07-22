/**
 * Turn-retry policy — the decision matrix the chat route's transient-failure
 * re-run loop keys on, and the continuation message that keeps a retry
 * CONTINUING committed work instead of restarting it.
 */

import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import type { ClassifiedError, ErrorType } from "../errorClassifier";
import { summarizeBlueprint } from "../summarizeBlueprint";
import {
	buildTurnRetryContinuation,
	MAX_TURN_RETRIES,
	shouldRetryTurn,
	turnRetryDelayMs,
} from "../turnRetry";

function classified(type: ErrorType): ClassifiedError {
	return { type, message: "m", recoverable: false };
}

describe("shouldRetryTurn", () => {
	const transient: ErrorType[] = [
		"api_server",
		"api_overloaded",
		"api_timeout",
		"api_rate_limit",
		"stream_broken",
	];
	const terminal: ErrorType[] = [
		"api_auth",
		"model_error",
		"out_of_credits",
		"generation_in_progress",
		"run_released",
		"access_revoked",
		"app_changed",
		"internal",
	];

	it("retries every transient bucket until the cap, then stops", () => {
		for (const type of transient) {
			for (let n = 0; n < MAX_TURN_RETRIES; n++) {
				expect(shouldRetryTurn(classified(type), n)).toBe(true);
			}
			expect(shouldRetryTurn(classified(type), MAX_TURN_RETRIES)).toBe(false);
		}
	});

	it("never retries a terminal bucket, even on the first failure", () => {
		for (const type of terminal) {
			expect(shouldRetryTurn(classified(type), 0)).toBe(false);
		}
	});
});

describe("turnRetryDelayMs", () => {
	it("spaces retries and clamps past the table", () => {
		const first = turnRetryDelayMs(1);
		const second = turnRetryDelayMs(2);
		expect(first).toBeGreaterThan(0);
		expect(second).toBeGreaterThan(first);
		// A hypothetical retry past the table reuses the last (longest) gap
		// rather than going to zero.
		expect(turnRetryDelayMs(3)).toBe(second);
	});
});

describe("buildTurnRetryContinuation", () => {
	it("returns null for an empty doc — a bare re-run IS the continuation", () => {
		expect(buildTurnRetryContinuation(buildDoc())).toBeNull();
	});

	it("carries the committed-state summary for a doc with modules", () => {
		const doc = buildDoc({
			appName: "Clinic",
			modules: [{ name: "Patients", forms: [] }],
		});
		const msg = buildTurnRetryContinuation(doc);
		expect(msg).not.toBeNull();
		expect(msg?.role).toBe("user");
		// The model must see the SAME state rendering the edit prompt uses —
		// one summarizer, no drift.
		expect(msg?.content).toContain(summarizeBlueprint(doc));
	});

	it("treats a committed case-type catalog alone as continuable state", () => {
		// A build that died right after `generateSchema` committed (no modules
		// yet) must still tell the retry the catalog exists — re-declaring a
		// type is the gate rejection the note exists to avoid.
		const doc = buildDoc({
			caseTypes: [{ name: "patient", properties: [] }],
		});
		expect(buildTurnRetryContinuation(doc)).not.toBeNull();
	});
});
