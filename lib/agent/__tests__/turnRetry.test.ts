/**
 * Turn-retry policy — the decision matrix the chat route's transient-failure
 * re-run loop keys on, and the continuation message that keeps a retry
 * CONTINUING committed work instead of restarting it.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f, withUserSequences } from "@/lib/__tests__/docHelpers";
import type { ClassifiedError, ErrorType } from "../errorClassifier";
import {
	buildTurnRetryContinuation,
	MAX_TURN_RETRIES,
	shouldRetryTurn,
	TURN_RETRY_MESSAGE,
	turnRetryDelayMs,
	turnRetryMessage,
} from "../turnRetry";
import { expectAdmittedDoc, surveyFixture } from "./admittedFixture";

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

describe("buildTurnRetryContinuation", () => {
	it("returns null for the pre-genesis empty context", () => {
		expect(buildTurnRetryContinuation(buildDoc())).toBeNull();
	});

	it("carries current app identities for a doc with modules", () => {
		const doc = expectAdmittedDoc(
			buildDoc({
				appName: "Clinic",
				modules: [
					{
						name: "Patients",
						forms: [
							{
								name: "Notes",
								type: "survey",
								fields: [f({ id: "note", kind: "text" })],
							},
						],
					},
				],
			}),
		);
		const msg = buildTurnRetryContinuation(doc);
		expect(msg).not.toBeNull();
		expect(msg?.role).toBe("user");
		// The continuation must carry actual authored identities and state,
		// independently of how the summary helper renders its other sections.
		expect(msg?.content).toContain('"name":"Clinic"');
		expect(msg?.content).toContain('"name":"Patients"');
		expect(msg?.content).toContain(doc.moduleOrder[0]);
		expect(msg?.content).toContain("already saved");
	});
});

it("carries worker configuration through provider retry and instance redrive", () => {
	const uuid = testUuid("retry-region");
	const doc = expectAdmittedDoc(
		withUserSequences({
			...surveyFixture(),
			userProperties: { [uuid]: { uuid, slug: "region", label: "Region" } },
		}),
	);
	for (const cause of ["provider-retry", "redrive"] as const) {
		const msg = buildTurnRetryContinuation(doc, cause);
		expect(msg?.content).toContain(
			JSON.stringify({ uuid, name: "region", label: "Region" }),
		);
		expect(msg?.content).toContain("already saved");
		if (cause === "redrive")
			expect(msg?.content).not.toContain("provider error");
	}
});
