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
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	type ValidationError,
	type ValidationErrorCode,
	validationError,
} from "@/lib/commcare/validator/errors";
import { VALIDITY_CLASS_BY_CODE } from "@/lib/commcare/validator/gate";

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
			moduleUuid: testUuid("11111111-1111-4111-8111-111111111111"),
			moduleName: "Clients",
			formUuid: testUuid("22222222-2222-4222-8222-222222222222"),
			formName: "Register Client",
			fieldUuid: testUuid("33333333-3333-4333-8333-333333333333"),
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

	it("gives duplicate worker-information choices a direct repair", () => {
		const line = userFacingError(
			validationError(
				"USER_PROPERTY_CHOICES_DUPLICATE",
				"app",
				"verbose internal message",
				{},
				{ slug: "region" },
			),
		);

		expect(line).not.toContain("on our end");
		expect(line).toMatch(/accepted (option|value)/i);
		expect(line).toMatch(/remove the repeated/i);
	});

	it("shows an empty or whitespace choice value for what it is, never as a bare pair of quotes", () => {
		const render = (optionValue: string, problem: string) =>
			userFacingError(
				validationError(
					"SELECT_OPTION_VALUE_INVALID",
					"field",
					"verbose internal message",
					{ formName: "Visit", fieldId: "answer" },
					{ optionValue, problem, suggestedValue: "not_applicable" },
				),
			);
		expect(render("", "empty")).toContain("has an empty stored value");
		expect(render("", "empty")).not.toContain('""');
		expect(render(" ", "whitespace")).toContain('" "');
		expect(render("a\tb", "whitespace")).toContain('"a\\tb"');
		expect(render("don't", "quote")).toContain("quote mark");
		expect(render("", "empty")).toContain('"not_applicable"');
	});

	it("explains a loop closed by a container's display condition as containment", () => {
		const line = userFacingError(
			validationError(
				"CYCLE",
				"form",
				"verbose internal message",
				{ formName: "Quiz" },
				{
					loop: "/data/question1 reads /data/first; /data/question1/question2 is inside the group /data/question1, so it follows that group's display condition; /data/first reads /data/question1/question2.",
					container: "/data/question1",
					containerKind: "group",
					descendant: "/data/question1/question2",
				},
			),
		);
		expect(line).toContain('the group "question1"');
		expect(line).toContain('"question2"');
		expect(line).toContain("question1 reads first");
		expect(line).not.toContain("/data/");
		expect(line).toMatch(/move "question2" out of the group/i);
	});

	it("keeps the reference-loop wording when no container is involved", () => {
		const line = userFacingError(
			validationError(
				"CYCLE",
				"form",
				"verbose internal message",
				{ formName: "Quiz" },
				{ loop: "/data/b reads /data/a; /data/a reads /data/b." },
			),
		);
		expect(line).toContain("depend on each other in a loop");
		expect(line).toContain("b reads a; a reads b.");
		expect(line).not.toContain("/data/");
	});
});

describe("userFacingError — delete-aware phrasing", () => {
	// These two fire in the builder mainly when REMOVING the last of something,
	// so the copy must not just say "add one" (which reads backwards on a delete).
	it("NO_MODULES names the remove path, not just 'add one'", () => {
		const line = userFacingError(richFinding("NO_MODULES"));
		expect(line).toMatch(/can't remove your last one/i);
		expect(line).toMatch(/add another/i);
	});

	it("NO_FORMS_OR_CASE_LIST is case-type-agnostic and delete-aware", () => {
		const line = userFacingError(richFinding("NO_FORMS_OR_CASE_LIST"));
		// Must not assume a case type (it now fires on plain survey modules too).
		expect(line).not.toMatch(/case type/i);
		expect(line).toMatch(/needs at least one form/i);
		expect(line).toMatch(/removing its last one/i);
	});

	it("offers every valid repair for a cross-type submenu under bare Results", () => {
		const line = userFacingError(
			richFinding("NESTED_MENU_CROSS_TYPE_ROOT_REQUIRES_FORM"),
		);
		expect(line).toMatch(/add a form to the parent/i);
		expect(line).toMatch(/use the same case type/i);
		expect(line).toMatch(/make this module top-level/i);
	});

	it("MISSING_CASE_LIST_COLUMNS explains how to replace the last result", () => {
		const line = userFacingError(richFinding("MISSING_CASE_LIST_COLUMNS"));
		expect(line).toMatch(/needs at least one result field/i);
		expect(line).toMatch(/add its replacement first/i);
	});
});

describe("userFacingError — case-list expression repairs", () => {
	function expressionFinding(reason: string): ValidationError {
		return validationError(
			"CASE_LIST_EXPRESSION_NOT_ON_DEVICE",
			"module",
			"internal implementation detail",
			{
				moduleUuid: testUuid("11111111-1111-4111-8111-111111111111"),
				moduleName: "Clients",
			},
			{
				reason,
				surface: "filter",
				property: "visit_date",
				value: "91, 0",
			},
		);
	}

	it.each([
		["unwrap-list", /saved list text/i],
		["multi-valued-relation-read", /several.*visit_date.*related cases/i],
		["mixed-property-scopes", /one condition for each case/i],
		["unrebasable-relation-scope", /move that condition outside/i],
		["nested-multi-case-count", /move the count to its own condition/i],
		["invalid-geopoint-center", /valid latitude and longitude/i],
	] as const)("explains %s with its own repair", (reason, repair) => {
		const line = userFacingError(expressionFinding(reason));
		expect(line).toMatch(repair);
		if (reason !== "unwrap-list") expect(line).not.toMatch(/saved list text/i);
	});
});

describe("userFacingError — date calculation findings", () => {
	function dateFinding(
		code:
			| "DISPLAY_CONDITION_NOT_ON_DEVICE"
			| "CASE_OPERATION_EXPRESSION_TYPE"
			| "LOOKUP_SELECT_FILTER_NOT_ON_DEVICE",
		reason: "datetime-base" | "calendar-interval",
	): ValidationError {
		return validationError(
			code,
			code === "LOOKUP_SELECT_FILTER_NOT_ON_DEVICE" ? "field" : "form",
			"internal implementation detail",
			{
				moduleName: "Clients",
				formName: "Register Client",
				fieldId: "visit_date",
			},
			{ reason, interval: reason === "datetime-base" ? "days" : "months" },
		);
	}

	it.each([
		"DISPLAY_CONDITION_NOT_ON_DEVICE",
		"CASE_OPERATION_EXPRESSION_TYPE",
		"LOOKUP_SELECT_FILTER_NOT_ON_DEVICE",
	] as const)("explains the lost-time refusal for %s", (code) => {
		const line = userFacingError(dateFinding(code, "datetime-base"));
		expect(line).toMatch(/time would be lost/i);
		expect(line).toMatch(/whole date|another calculation/i);
	});

	it.each([
		"DISPLAY_CONDITION_NOT_ON_DEVICE",
		"CASE_OPERATION_EXPRESSION_TYPE",
		"LOOKUP_SELECT_FILTER_NOT_ON_DEVICE",
	] as const)("explains the calendar-interval refusal for %s", (code) => {
		const line = userFacingError(dateFinding(code, "calendar-interval"));
		expect(line).toMatch(/month or year|months or years/i);
		expect(line).toMatch(/days.*weeks/i);
	});
});
