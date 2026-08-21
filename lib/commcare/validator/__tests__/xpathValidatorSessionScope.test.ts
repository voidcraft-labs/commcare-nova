import { describe, expect, it } from "vitest";
import {
	SESSION_FORM_READ_MESSAGE,
	validateXPath,
} from "@/lib/commcare/validator/xpathValidator";

const accept = new Map([
	["patient", new Set(["case_id", "mood", "last_note"])],
	["household", new Set(["case_id", "village"])],
]);

describe("validateXPath under session scope", () => {
	it("refuses a #form/ reference with the session sentence, once", () => {
		const errors = validateXPath(
			"#form/note = 'yes'",
			new Set(),
			accept,
			false,
			"session",
		);
		expect(errors).toEqual([
			{
				code: "INVALID_REF",
				message: SESSION_FORM_READ_MESSAGE,
				position: 0,
				ref: "#form/note",
			},
		]);
	});

	it("refuses a /data/ path with the session sentence at its text", () => {
		const errors = validateXPath(
			"1 = /data/note",
			new Set(),
			accept,
			false,
			"session",
		);
		expect(errors).toEqual([
			{
				code: "INVALID_REF",
				message: SESSION_FORM_READ_MESSAGE,
				position: 4,
				ref: "/data/note",
			},
		]);
	});

	it("refuses a bare relative name: there is no context node after the form closes", () => {
		const errors = validateXPath(
			"mood = 'good'",
			new Set(),
			accept,
			false,
			"session",
		);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({
			code: "INVALID_REF",
			position: 0,
			ref: "mood",
		});
		expect(errors[0]?.message).toContain("after the form has closed");
	});

	it("accepts readable case and user references", () => {
		expect(
			validateXPath(
				"#patient/mood = 'good' and #household/village != '' and #user/role = 'chw'",
				new Set(),
				accept,
				false,
				"session",
			),
		).toEqual([]);
	});

	it("still refuses an unknown case property by the case rule", () => {
		const errors = validateXPath(
			"#patient/nope = 1",
			new Set(),
			accept,
			false,
			"session",
		);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.code).toBe("INVALID_CASE_REF");
	});

	it("leaves form scope exactly as it was", () => {
		const valid = new Set(["/data/note"]);
		expect(validateXPath("#form/note = 'yes'", valid, accept)).toEqual([]);
		expect(validateXPath("/data/note = 'yes'", valid, accept)).toEqual([]);
		expect(validateXPath("mood = 'good'", valid, accept)).toEqual([]);
	});
});
