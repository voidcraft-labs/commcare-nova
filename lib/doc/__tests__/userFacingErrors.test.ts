/**
 * The user-facing copy renderer's two contracts:
 *
 *   1. Exhaustiveness — every code a user can actually encounter
 *      (classified shape / soundness / completeness / environment in
 *      `VALIDITY_CLASS_BY_CODE`) has a builder. A new gating code added
 *      without one is caught here, not by a user seeing the generic line.
 *   2. No wire/platform vocabulary leaks into the rendered output — the
 *      whole point of the surface. Render every code against a populated
 *      finding and assert the banned-term sweep stays clean.
 */

import { describe, expect, it } from "vitest";
import {
	type ValidationError,
	type ValidationErrorCode,
	validationError,
} from "@/lib/commcare/validator/errors";
import { VALIDITY_CLASS_BY_CODE } from "@/lib/commcare/validator/gate";
import { asUuid } from "@/lib/doc/types";
import {
	USER_MESSAGE_CODES,
	userFacingError,
} from "@/lib/doc/userFacingErrors";

/** A finding with every location + details slot a builder might read,
 *  so the rendered output exercises the interpolated path (not the
 *  fallback) for whichever keys the code consumes. */
function richFinding(code: ValidationErrorCode): ValidationError {
	return validationError(
		code,
		"form",
		"verbose internal message — not under test",
		{
			moduleUuid: asUuid("11111111-1111-4111-8111-111111111111"),
			moduleName: "Clients",
			formUuid: asUuid("22222222-2222-4222-8222-222222222222"),
			formName: "Register Client",
			fieldUuid: asUuid("33333333-3333-4333-8333-333333333333"),
			fieldId: "client_age",
			field: "calculate",
		},
		{
			caseType: "patient",
			property: "age",
			reservedName: "case_name",
			connectId: "learn_1",
			connectKind: "learn module",
			inputName: "by_name",
			field: "age",
			value: "yes",
			bareWord: "yes",
			expectedKind: "image",
			hashtag: "#patient/age",
			fieldId: "client_age",
			repeatId: "visits",
			fixtureId: "lookup_table",
		},
	);
}

const GATING_OR_ENV: ReadonlySet<ValidationErrorCode> = new Set(
	(Object.keys(VALIDITY_CLASS_BY_CODE) as ValidationErrorCode[]).filter(
		(code) => {
			const cls = VALIDITY_CLASS_BY_CODE[code];
			return (
				cls === "shape" ||
				cls === "soundness" ||
				cls === "completeness" ||
				cls === "environment"
			);
		},
	),
);

describe("userFacingError — exhaustiveness", () => {
	it("has a builder for every shape/soundness/completeness/environment code", () => {
		const missing = [...GATING_OR_ENV].filter(
			(code) => !USER_MESSAGE_CODES.has(code),
		);
		expect(missing).toEqual([]);
	});

	it("does not carry builders for codes that can't reach a user (oracle)", () => {
		// A builder for an oracle code is dead copy — runValidation never
		// emits it. Keeps the table honest about its reachable surface.
		const oracleWithBuilder = [...USER_MESSAGE_CODES].filter(
			(code) => VALIDITY_CLASS_BY_CODE[code] === "oracle",
		);
		expect(oracleWithBuilder).toEqual([]);
	});
});

describe("userFacingError — voice", () => {
	// The terms the builder surface must never speak. The validator's
	// verbose `message` may use any of these; the rendered user line may
	// not. Word-boundary matched, case-insensitive.
	const BANNED = [
		"xml",
		"xform",
		"xpath",
		"suite",
		"nodeset",
		"node name",
		"element name",
		"javarosa",
		"jr:",
		"itext",
		"instance(",
		"navigation menu",
		"wire",
		"commcare-nova",
		// Raw schema/slot keys — wire-internal, never the user's vocabulary.
		// (A `#…` hashtag is NOT banned: it's the reference syntax users
		// type in formula fields, so echoing their own token is helpful.)
		"case_property_on",
		"case_preload",
	];

	it("renders every gating/environment code with no wire vocabulary", () => {
		const offenders: Array<{ code: string; term: string; line: string }> = [];
		for (const code of GATING_OR_ENV) {
			const line = userFacingError(richFinding(code)).toLowerCase();
			for (const term of BANNED) {
				if (line.includes(term)) {
					offenders.push({ code, term, line });
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	it("never leaves an unresolved placeholder or bare undefined", () => {
		for (const code of GATING_OR_ENV) {
			const line = userFacingError(richFinding(code));
			expect(line).not.toMatch(/\{[a-zA-Z]/); // no {placeholder}
			expect(line.toLowerCase()).not.toContain("undefined");
			expect(line.length).toBeGreaterThan(0);
		}
	});

	it("falls back to the generic internal line for an oracle code", () => {
		const line = userFacingError(richFinding("XFORM_PARSE_ERROR"));
		expect(line).toContain("on our end");
	});
});
