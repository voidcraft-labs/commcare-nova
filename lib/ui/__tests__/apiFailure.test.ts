/**
 * `describeApiFailure` / `apiFailureToastBody` — the pure transformation
 * between an API error body and what the triggering affordance displays.
 * The boundary-gate rejections ride this path (export toast, upload
 * dialog), so the contract under test is: the validator's per-finding
 * lines survive to the surface, and malformed bodies degrade to the
 * fallback instead of throwing.
 */

import { describe, expect, it } from "vitest";
import { apiFailureToastBody, describeApiFailure } from "../apiFailure";

describe("describeApiFailure", () => {
	it("passes a gate rejection's headline + detail lines through", () => {
		const body = {
			error: "The app could not be exported.",
			details: [
				"The registration form has no fields.",
				"The Patients workflow has no case type.",
			],
		};
		expect(describeApiFailure(body, "Export failed.")).toEqual({
			message: body.error,
			details: body.details,
		});
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
		expect(
			describeApiFailure({ error: "", details: "not an array" }, "fallback"),
		).toEqual({ message: "fallback", details: [] });
		expect(
			describeApiFailure({ error: 42, details: ["retained"] }, "fallback"),
		).toEqual({ message: "fallback", details: ["retained"] });
	});
});

describe("apiFailureToastBody", () => {
	it("rides detail lines on the structured lines slot", () => {
		expect(
			apiFailureToastBody({ message: "headline", details: ["a", "b"] }),
		).toEqual({ message: undefined, lines: ["a", "b"] });
	});

	it("falls back to the plain message when there are no details", () => {
		expect(apiFailureToastBody({ message: "headline", details: [] })).toEqual({
			message: "headline",
			lines: undefined,
		});
	});
});
