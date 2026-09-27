/** Bounded transient-provider retry policy. Private state is read by the route. */

import { describe, expect, it } from "vitest";
import type { ClassifiedError, ErrorType } from "../errorClassifier";
import {
	MAX_TURN_RETRIES,
	shouldRetryTurn,
	TURN_RETRY_MESSAGE,
	turnRetryDelayMs,
	turnRetryMessage,
} from "../turnRetry";

describe("turnRetryMessage", () => {
	it("names a flagged prompt for what it is rather than a provider outage", () => {
		const flagged = turnRetryMessage("prompt_flagged");
		expect(flagged).not.toBe(TURN_RETRY_MESSAGE);
		expect(flagged).toContain("flagged");
		expect(flagged).not.toContain("temporary provider error");
		expect(flagged).toContain("automatically");
	});

	it("keeps the generic wording for every other transient bucket", () => {
		for (const type of [
			"api_server",
			"api_overloaded",
			"api_timeout",
			"api_rate_limit",
			"stream_broken",
		] as const) {
			expect(turnRetryMessage(type)).toBe(TURN_RETRY_MESSAGE);
		}
	});
});

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
		// OpenAI's `invalid_prompt` moderation verdict is not deterministic over
		// an unchanged request, so a re-send is the right first response.
		"prompt_flagged",
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
