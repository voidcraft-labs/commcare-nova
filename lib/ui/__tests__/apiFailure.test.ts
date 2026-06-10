/**
 * `describeApiFailure` / `apiFailureToastMessage` — the pure transformation
 * between an API error body and what the triggering affordance displays.
 * The boundary-gate rejections ride this path (export toast, upload
 * dialog), so the contract under test is: the validator's per-finding
 * lines survive to the surface, and malformed bodies degrade to the
 * fallback instead of throwing.
 */

import { describe, expect, it } from "vitest";
import { apiFailureToastMessage, describeApiFailure } from "../apiFailure";

describe("describeApiFailure", () => {
	it("passes a gate rejection's headline + detail lines through", () => {
		const failure = describeApiFailure(
			{
				error:
					"This app isn't ready to export — fix the issues below, then try again.",
				details: [
					'"Reg" in "Patients" has no fields. CommCare can\'t build an empty form — add at least one field.',
					'Module "Patients" has registration, followup, or close forms but no case_type.',
				],
			},
			"Could not generate the JSON file.",
		);

		expect(failure.message).toContain("isn't ready to export");
		expect(failure.details).toHaveLength(2);
		expect(failure.details[0]).toContain("has no fields");
	});

	it("degrades to the fallback for a non-JSON / null body", () => {
		expect(describeApiFailure(null, "fallback")).toEqual({
			message: "fallback",
			details: [],
		});
		expect(describeApiFailure("plain text", "fallback")).toEqual({
			message: "fallback",
			details: [],
		});
	});

	it("tolerates a malformed details array (drops non-strings, keeps strings)", () => {
		const failure = describeApiFailure(
			{ error: "headline", details: ["ok", 42, null, "also ok"] },
			"fallback",
		);
		expect(failure.message).toBe("headline");
		expect(failure.details).toEqual(["ok", "also ok"]);
	});

	it("uses the fallback when `error` is missing or empty", () => {
		expect(describeApiFailure({ details: ["x"] }, "fallback").message).toBe(
			"fallback",
		);
		expect(describeApiFailure({ error: "" }, "fallback").message).toBe(
			"fallback",
		);
	});
});

describe("apiFailureToastMessage", () => {
	it("joins detail lines one-per-line for the toast body", () => {
		expect(
			apiFailureToastMessage({ message: "headline", details: ["a", "b"] }),
		).toBe("a\nb");
	});

	it("falls back to the message when there are no details", () => {
		expect(apiFailureToastMessage({ message: "headline", details: [] })).toBe(
			"headline",
		);
	});
});
