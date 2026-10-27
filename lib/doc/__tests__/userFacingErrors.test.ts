/**
 * The user-facing copy renderer's two contracts:
 *
 *   1. Every reachable code renders useful copy with and without optional
 *      details. Completeness of the builder table is a compile-time contract.
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
	offeredChoiceRefusal,
	userFacingError,
	userFacingErrors,
} from "@/lib/doc/userFacingErrors";

/** Common location/details for the copy checks. Reason-specific builders
 * have their own examples below; this is not a validator fixture. */
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

const GATING_OR_ENV = (
	Object.keys(VALIDITY_CLASS_BY_CODE) as ValidationErrorCode[]
).filter((code) => {
	const cls = VALIDITY_CLASS_BY_CODE[code];
	return (
		cls === "shape" ||
		cls === "soundness" ||
		cls === "completeness" ||
		cls === "environment"
	);
});

describe("userFacingError — voice", () => {
	// The terms the builder surface must never speak. The validator's
	// verbose `message` may use any of these; the rendered user line may
	// not. This checks authored copy, not words a user might put in a label.
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

	it.each(["populated", "missing"] as const)(
		"renders reachable codes with %s details without internal copy or broken interpolation",
		(kind) => {
			for (const code of GATING_OR_ENV) {
				const finding =
					kind === "populated"
						? richFinding(code)
						: validationError(code, "app", "INTERNAL DETAIL", {});
				const line = userFacingError(finding);
				expect(line, code).not.toMatch(
					/\{[a-zA-Z]|undefined|INTERNAL DETAIL|on our end/,
				);
				expect(line.trim().length, code).toBeGreaterThan(0);
				for (const term of BANNED)
					expect(line.toLowerCase(), code).not.toContain(term);
			}
		},
	);

	it("keeps internal failures generic and renders ordered lists and withheld choices through the same voice", () => {
		const internal = validationError(
			"XFORM_PARSE_ERROR",
			"app",
			"INTERNAL DETAIL",
			{},
		);
		const missingName = validationError(
			"EMPTY_APP_NAME",
			"app",
			"INTERNAL DETAIL",
			{},
		);
		const generic =
			"Something went wrong preparing your app. This is on our end. Try again, and let us know if it keeps happening.";
		const name = "Your app needs a name. Add one to get started.";
		for (const [code, validity] of Object.entries(VALIDITY_CLASS_BY_CODE)) {
			if (validity === "oracle")
				expect(userFacingError(richFinding(code as ValidationErrorCode))).toBe(
					generic,
				);
		}
		expect(userFacingErrors([missingName, internal, missingName])).toEqual([
			name,
			generic,
			name,
		]);
		expect(userFacingErrors([])).toEqual([]);
		expect(offeredChoiceRefusal([missingName, internal])).toBe(name);
		expect(offeredChoiceRefusal([internal, missingName])).toBe(generic);
		expect(offeredChoiceRefusal([])).toBe("This choice isn't available here.");
	});

	it("names the repair for a duplicate deep link ID", () => {
		const line = userFacingError(
			validationError(
				"ENTRY_POINT_INVALID",
				"app",
				"Internal detail",
				{},
				{ reason: "duplicate-id" },
			),
		);
		expect(line).toContain("Give one of them a different ID");
	});

	it("says the identifier sentence each surface says, with its free name", () => {
		const location = {
			moduleUuid: testUuid("11111111-1111-4111-8111-111111111111"),
			formUuid: testUuid("22222222-2222-4222-8222-222222222222"),
			formName: "Register Client",
			fieldUuid: testUuid("33333333-3333-4333-8333-333333333333"),
			fieldId: "_notes",
		};
		expect(
			userFacingError(
				validationError("INVALID_FIELD_ID", "field", "Internal", location, {
					problem: "leading-underscore",
					suggestedId: "notes",
				}),
			),
		).toBe(
			'"_notes" in "Register Client" needs another ID. A question ID can\'t start with an underscore, because CommCare HQ\'s form builder can\'t keep it. "notes" is free here.',
		);
		expect(
			userFacingError(
				validationError(
					"CONNECT_ID_INVALID_FORMAT",
					"form",
					"Internal",
					location,
					{
						connectId: "task",
						problem: "reserved-name",
						suggestedId: "q_task",
					},
				),
			),
		).toBe(
			'The Connect ID "task" in "Register Client" needs a change. "task" is a name CommCare Connect keeps for itself, and it can\'t receive a form whose block is called that. "q_task" is free here.',
		);
		expect(
			userFacingError(
				validationError(
					"ENTRY_POINT_INVALID",
					"app",
					"Internal",
					{},
					{
						reason: "id-format",
						problem: "edge",
						suggestedId: "intake",
					},
				),
			),
		).toBe(
			"A deep link ID starts and ends with a lowercase letter or a digit, because CommCare HQ won't save one that doesn't. \"intake\" is free here.",
		);
		expect(
			userFacingError(
				validationError(
					"CASE_OPERATION_LINK_INVALID",
					"form",
					"Internal",
					location,
					{
						linkIdentifier: "create",
						problem: "reads_as_case_action",
						suggestedId: "q_create",
					},
				),
			),
		).toBe(
			'"create" is a name CommCare HQ\'s form builder reads as starting a new case. "q_create" is free here.',
		);
		expect(
			userFacingError(
				validationError(
					"CASE_OPERATION_INVALID_ID",
					"form",
					"Internal",
					location,
					{
						operationId: "bind",
						problem: "stops_form_builder",
						suggestedId: "q_bind",
					},
				),
			),
		).toBe(
			'"bind" is a name CommCare HQ\'s form builder can\'t open a form with. "q_bind" is free here.',
		);
		expect(
			userFacingError(
				validationError(
					"CASE_PROPERTY_NAME_FORM_BUILDER_CANNOT_KEEP",
					"form",
					"Internal",
					location,
					{ property: "close", problem: "closes_case" },
				),
			),
		).toBe(
			'"_notes" in "Register Client" saves the case property "close". CommCare HQ\'s form builder reads a property named "close" as closing the case, so editing this form there would close the case every time it\'s sent. Save it under another property name here.',
		);
		const {
			fieldUuid: _fieldUuid,
			fieldId: _fieldId,
			...formLocation
		} = location;
		expect(
			userFacingError(
				validationError(
					"CASE_PROPERTY_NAME_FORM_BUILDER_CANNOT_KEEP",
					"form",
					"Internal",
					formLocation,
					{
						operationId: "visit_update",
						property: "bind",
						problem: "stops_form_builder",
					},
				),
			),
		).toBe(
			'The case change "visit_update" in "Register Client" saves the case property "bind". CommCare HQ\'s form builder can\'t open a form that saves a property named "bind" from a case change. Save it under another property name here.',
		);
		/* A Connect setting's formula belongs to the form, so the read of the
		 * form's root names the setting, not a field. */
		expect(
			userFacingError(
				validationError("INVALID_REF", "form", "Internal", formLocation, {
					ref: "/data",
				}),
			),
		).toBe(
			'A CommCare Connect setting of "Register Client" reads the whole form, not a question. You can point it at a question, a group or a repeat instead.',
		);
		expect(
			userFacingError(
				validationError(
					"FIELD_ID_NAMES_CONNECT_BLOCK",
					"field",
					"Internal",
					location,
					{ fieldId: "_notes", suggestedId: "notes_2" },
				),
			),
		).toBe(
			'"_notes" and a CommCare Connect block of "Register Client" share one name, so the form would hold two items CommCare can\'t tell apart. You can rename the field, or give the block another ID. "notes_2" is free for the field.',
		);
	});

	it("names the value two choices share and the one free for the second", () => {
		expect(
			userFacingError(
				validationError(
					"SELECT_OPTION_VALUE_DUPLICATE",
					"field",
					"Internal",
					{ formName: "Visit", fieldId: "answer" },
					{ optionValue: "yes", suggestedValue: "yes_2", problem: "duplicate" },
				),
			),
		).toBe(
			'Two choices of "answer" in "Visit" both store "yes", so a saved answer can\'t say which was chosen. "yes_2" is free for the second.',
		);
		expect(
			userFacingError(
				validationError(
					"CASE_PROPERTY_OPTION_VALUE_DUPLICATE",
					"app",
					"Internal",
					{},
					{
						caseType: "client",
						property: "status",
						optionValue: "open",
						suggestedValue: "open_2",
						problem: "duplicate",
					},
				),
			),
		).toBe(
			'Two choices of the "client" property "status" both store "open", so a saved value can\'t say which was chosen. "open_2" is free for the second.',
		);
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

	it("names a search field's required condition, check, and hidden value rather than the module's Cases available rule", () => {
		const subjects = [
			["search-input-required", /required condition for search field "Region"/],
			["search-input-validation", /check on search field "Region"/],
			["search-input-hidden-value", /hidden search value "Region"/],
		] as const;
		for (const code of [
			"CASE_LIST_DATE_ADD_NOT_ON_DEVICE",
			"CASE_LIST_MATCH_MODE_NOT_ON_DEVICE",
			"CASE_LIST_EXPRESSION_NOT_ON_DEVICE",
			"CASE_LIST_STRICT_NULL_NOT_PORTABLE",
		] as const) {
			for (const [surface, expected] of subjects) {
				const line = userFacingError(
					validationError(
						code,
						"module",
						"verbose internal message",
						{ moduleName: "Clients" },
						{ surface, inputLabel: "Region", interval: "months" },
					),
				);
				expect(line, `${code} on ${surface}`).toMatch(expected);
				expect(line).not.toContain("Cases available rule");
			}
		}
	});

	it("explains a changed several-case selection without hiding the repair", () => {
		const line = userFacingError(
			validationError(
				"FORM_LINK_SELECTION_CASE_TYPE_CHANGED",
				"form",
				"verbose internal message",
				{ formName: "Review patients" },
				{ expectedCaseType: "patient" },
			),
		);

		expect(line).toBe(
			'A Case change in "Review patients" can change the selected cases to another type before the next form opens. Send people to the destination\'s form list so they can choose matching cases, or keep every selected case as "patient".',
		);
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

describe("userFacingError — what CommCare HQ cannot take", () => {
	const nested = (details: Record<string, string>) =>
		userFacingError(
			validationError(
				"HQ_NESTED_SELECTION_UNREPRESENTABLE",
				"module",
				"INTERNAL DETAIL",
				{ moduleUuid: testUuid("11111111-1111-4111-8111-111111111111") },
				{ exportMode: "hq-upload", ...details },
			),
		);

	it("names both menus and the one edit for each selection", () => {
		expect(
			nested({
				reason: "multiple-parent-relation",
				sourceModuleName: "Parents",
				targetModuleName: "Child care",
				sourceMaximum: "5",
			}),
		).toBe(
			'CommCare HQ can\'t yet find the cases for "Child care" from several cases selected in "Parents". You can set "Parents" to select one case. Preview keeps this selection, and so does a CCZ for a project space the app is already published to.',
		);
		expect(
			nested({
				reason: "smaller-child-maximum",
				sourceModuleName: "Parents",
				targetModuleName: "Child care",
				sourceMaximum: "5",
				targetMaximum: "4",
			}),
		).toBe(
			'CommCare HQ can\'t yet keep the limit of 4 selected cases in "Child care" under "Parents", which selects up to 5. You can raise the limit in "Child care" to 5 or more. Preview keeps this selection, and so does a CCZ for a project space the app is already published to.',
		);
	});

	it("reads a menu with no name by its place in the selection", () => {
		expect(
			nested({ reason: "multiple-parent-relation", sourceMaximum: "5" }),
		).toBe(
			"CommCare HQ can't yet find the cases for this menu from several cases selected in the parent menu. You can set the parent menu to select one case. Preview keeps this selection, and so does a CCZ for a project space the app is already published to.",
		);
		expect(
			nested({
				reason: "smaller-child-maximum",
				targetModuleName: "Child care",
				sourceMaximum: "5",
				targetMaximum: "4",
			}),
		).toBe(
			'CommCare HQ can\'t yet keep the limit of 4 selected cases in "Child care" under the parent menu, which selects up to 5. You can raise the limit in "Child care" to 5 or more. Preview keeps this selection, and so does a CCZ for a project space the app is already published to.',
		);
	});

	it("sends a padded lookup cell to Project data and to no download", () => {
		const line = userFacingError(
			validationError(
				"LOOKUP_CELL_TEXT_CHANGED_BY_HQ",
				"app",
				"INTERNAL DETAIL",
				{},
				{ columnLabel: "Name", tableName: "Clinics" },
			),
		);
		expect(line).toBe(
			'The "Name" column in "Clinics" has leading or trailing whitespace that CommCare HQ would remove. You can remove that whitespace in Project data.',
		);
	});
});

describe("userFacingError — the checker's and writer agreement's reasons", () => {
	function finding(
		code: ValidationErrorCode,
		details: Record<string, string>,
		location: Partial<ValidationError["location"]> = {},
	): ValidationError {
		return validationError(
			code,
			"field",
			"internal implementation detail",
			{
				moduleName: "Clients",
				formName: "Register Client",
				fieldId: "visit_check",
				field: "relevant",
				...location,
			},
			details,
		);
	}

	it.each([
		[
			"XPATH_INCOMPATIBLE_VALUES",
			{ reason: "date-datetime" },
			'A formula on "visit_check" in "Register Client" compares a date with a date and time. You can wrap the date and time in date() to compare days.',
		],
		[
			"XPATH_INCOMPATIBLE_VALUES",
			{ reason: "datetime-ordering" },
			'A formula on "visit_check" in "Register Client" orders a date and time against something that isn\'t one. You can compare it with another date and time, or wrap it in date() to compare days.',
		],
		[
			"XPATH_INCOMPATIBLE_VALUES",
			{
				reason: "day-only-on-device",
				comparison: "ordering",
				systemDate: "date_opened",
			},
			'A formula on "visit_check" in "Register Client" compares when the case was opened with a moment. On a device CommCare keeps only the day a case was opened, so it can\'t tell. You can wrap both sides in date() to compare days.',
		],
		[
			"XPATH_INCOMPATIBLE_VALUES",
			{
				reason: "day-only-on-device",
				comparison: "equality",
				systemDate: "last_modified",
			},
			'A formula on "visit_check" in "Register Client" checks whether the case was last changed at an exact moment. On a device CommCare keeps only the day a case was last changed, so the two never match. You can wrap both sides in date() to compare days.',
		],
		[
			"XPATH_INCOMPATIBLE_VALUES",
			{ reason: "clock-lost", comparison: "ordering", clockSource: "stamp" },
			'A formula on "visit_check" in "Register Client" compares "stamp", which has kept only the day of a date and time, with a moment. You can compare the date and time from the question or value that first recorded it, or wrap both sides in date() to compare days.',
		],
		[
			"XPATH_INCOMPATIBLE_VALUES",
			{ reason: "clock-lost" },
			'A formula on "visit_check" in "Register Client" compares a value, which has kept only the day of a date and time, with a moment. You can compare the date and time from the question or value that first recorded it, or wrap both sides in date() to compare days.',
		],
		[
			"XPATH_INCOMPATIBLE_VALUES",
			{ reason: "unreadable-datetime" },
			'A formula on "visit_check" in "Register Client" uses a value Nova can\'t read as a date and time. You can write it like 2026-01-02T10:30:00Z, with a four-digit year and a day and time that exist.',
		],
		[
			"XPATH_INCOMPATIBLE_VALUES",
			{ reason: "datetime-equality" },
			'A formula on "visit_check" in "Register Client" compares a date and time with something that isn\'t one, so the two never match. You can compare it with another date and time, or check whether it\'s blank.',
		],
		[
			"CASE_LIST_FILTER_TYPE_ERROR",
			{
				checkCode: "incompatible-values",
				checkReason: "day-only-on-device",
				comparison: "equality",
				systemDate: "date_opened",
			},
			'The Cases available setting in "Clients" checks whether the case was opened at an exact moment. On a device CommCare keeps only the day a case was opened, so the two never match. You can wrap both sides in date() to compare days.',
		],
		[
			"CASE_LIST_FILTER_TYPE_ERROR",
			{
				checkCode: "incompatible-values",
				checkReason: "day-only-on-device",
			},
			'The Cases available setting in "Clients" compares when the case was opened or last changed with a moment. On a device CommCare keeps only the day a case was opened or last changed, so it can\'t tell. You can wrap both sides in date() to compare days.',
		],
		[
			"CASE_LIST_FILTER_TYPE_ERROR",
			{ checkCode: "incompatible-values", checkReason: "date-datetime" },
			'The Cases available setting in "Clients" compares values that don\'t go together. Open the condition and adjust the comparison.',
		],
		[
			"LOOKUP_SELECT_FILTER_TYPE_ERROR",
			{
				checkCode: "incompatible-values",
				checkReason: "clock-lost",
				reason: "clock-lost",
			},
			'The lookup-choice filter of "visit_check" in "Register Client" compares a value, which has kept only the day of a date and time, with a moment, so the two can\'t line up. You can compare the date and time from the question or value that first recorded it, or wrap both sides in date() to compare days.',
		],
		[
			"CASE_SELECT_FILTER_INVALID",
			{
				checkCode: "incompatible-values",
				checkReason: "clock-lost",
				comparison: "equality",
				clockSource: "stamp",
			},
			'The choice filter of "visit_check" compares "stamp", which has kept only the day of a date and time, with a moment, so the two can\'t line up. You can compare the date and time from the question or value that first recorded it, or wrap both sides in date() to compare days.',
		],
		[
			"MODULE_DISPLAY_CONDITION_TYPE_ERROR",
			{
				checkCode: "incompatible-values",
				checkReason: "day-only-on-device",
				comparison: "ordering",
				systemDate: "last_modified",
			},
			'The display condition for "Clients" compares when the case was last changed with a moment. On a device CommCare keeps only the day a case was last changed, so it can\'t tell. You can wrap both sides in date() to compare days.',
		],
		[
			"XPATH_INCOMPATIBLE_VALUES",
			{ reason: "boolean" },
			'A formula on "visit_check" in "Register Client" compares a true-or-false result with another kind of value, and anything that isn\'t blank or zero counts as true. You can compare the two values themselves, or use the true-or-false result on its own.',
		],
		[
			"XPATH_MANY_VALUES",
			{ reason: "repeat", repeatId: "visits" },
			'A formula on "visit_check" in "Register Client" reads an answer from every entry of the repeat "visits" where it needs one value. You can count or join the entries, or read just one of them.',
		],
		[
			"XPATH_MANY_VALUES",
			{ reason: "selected-cases", menuName: "Households" },
			'A formula on "visit_check" in "Register Client" reads every case chosen in "Households" where it needs one value. You can count or join them.',
		],
		[
			"XPATH_FUNCTION_CONTEXT_UNAVAILABLE",
			{ reason: "here", hereSurface: "form" },
			'A formula on "visit_check" in "Register Client" uses here(), which is where the worker is. A case list knows that and a form doesn\'t. You can add a location question and use its answer instead.',
		],
		[
			"XPATH_FUNCTION_CONTEXT_UNAVAILABLE",
			{ reason: "here", hereSurface: "record" },
			'A formula on "visit_check" in "Register Client" uses here(), which is where the worker is. Only a case list\'s calculated column can read that. You can show it in a calculated column instead.',
		],
		[
			"XPATH_FUNCTION_CONTEXT_UNAVAILABLE",
			{ reason: "choice-name-dynamic", choiceFieldId: "village" },
			'A formula on "visit_check" in "Register Client" asks for the label of a choice of "village", whose choices come from a Project data table or from cases. You can read the label from where the choices come from instead.',
		],
		[
			"XPATH_FUNCTION_CONTEXT_UNAVAILABLE",
			{ reason: "choice-name", choiceFieldId: "village" },
			'A formula on "visit_check" in "Register Client" asks for the label of a choice of "village", which a form can\'t read here. You can use the answer itself instead.',
		],
		[
			"XPATH_FUNCTION_CONTEXT_UNAVAILABLE",
			{
				reason: "itext-reference",
				wordingKind: "question",
				wordingFieldId: "client_name",
			},
			'A formula on "visit_check" in "Register Client" reads the wording of "client_name", which shows an answer. CommCare would show a placeholder there instead of the answer. You can read the answer itself instead.',
		],
		[
			"XPATH_FUNCTION_CONTEXT_UNAVAILABLE",
			{
				reason: "itext-reference",
				wordingKind: "choice",
				wordingFieldId: "village",
			},
			'A formula on "visit_check" in "Register Client" reads the label of a choice of "village", and a label of its choices shows an answer. CommCare would show a placeholder there instead of the answer. You can read the answer itself instead.',
		],
		[
			"SEARCH_RESULTS_NOT_SUPPLIED",
			{ reason: "not-search-first" },
			'"visit_check" reads what "Clients"\'s search found, but "Clients" no longer opens on its search, so "Register Client" has no search results. You can turn Search first back on, or read the case the worker chose instead.',
		],
		[
			"SEARCH_RESULTS_NOT_SUPPLIED",
			{ reason: "no-matches-form" },
			'"visit_check" reads what the search found, but "Register Client" opens only when the search finds nothing. You can read the worker\'s search answers with #search/ instead.',
		],
		[
			"SEARCH_RESULTS_READ_INVALID",
			{ reason: "order" },
			'A formula on "visit_check" in "Register Client" reads what the search found by its order. CommCare\'s search returns its cases in no fixed order, so the first or last result can change from one search to the next. You can count the results, or read a value of the case the worker chose.',
		],
		[
			"SEARCH_RESULTS_READ_INVALID",
			{ reason: "other-type", caseType: "client", otherCaseType: "household" },
			'A formula on "visit_check" in "Register Client" looks for household cases in what the search found, but this search only finds client cases, so no result is one. You can remove that case type from the formula.',
		],
		[
			"LOCATIONS_READ_NEEDS_ORGANIZATION",
			{},
			'"visit_check" reads places, but this app has no organization yet. You can add your organization\'s levels in App setup first.',
		],
		[
			"INVALID_REF",
			{ identity: "wording" },
			'A formula on "visit_check" in "Register Client" reads wording that its form no longer has. You can read a question\'s current wording, or remove that read.',
		],
		[
			"INVALID_REF",
			{ identity: "place" },
			'A formula on "visit_check" in "Register Client" reads a place level or a piece of place information that no longer exists. You can choose a current one, or remove that read.',
		],
		[
			"TYPE_ERROR",
			{ reason: "datetime-literal-precision" },
			'A formula on "visit_check" in "Register Client" has a time finer than a millisecond, and CommCare compares times to the millisecond. You can choose a time to the millisecond, second or minute.',
		],
		[
			"HIDDEN_VALUE_WRITER_TYPE_MISMATCH",
			{
				reason: "type",
				property: "visit_date",
				valueType: "text",
				propertyType: "date",
				consequence: "stops-form",
			},
			'"visit_check" saves text to "visit_date", which holds dates. A form that fills a question from it would stop when it opens. You can change its calculation to give a date, or save it somewhere else.',
		],
		[
			"HIDDEN_VALUE_WRITER_TYPE_MISMATCH",
			{
				reason: "type",
				property: "tags",
				valueType: "text",
				propertyType: "multi_select",
				consequence: "wrong-kind",
			},
			'"visit_check" saves text to "tags", which holds several choices. Forms and case lists that read it would get the wrong kind of value. You can change its calculation to give several choices, or save it somewhere else.',
		],
		[
			"HIDDEN_VALUE_WRITER_TYPE_MISMATCH",
			{
				reason: "type",
				property: "visit_date",
				valueType: "text",
				valueTypes: "text,int",
				propertyType: "date",
				consequence: "stops-form",
			},
			'"visit_check" saves text or a whole number to "visit_date", which holds dates. A form that fills a question from it would stop when it opens. You can change its calculation to give a date, or save it somewhere else.',
		],
		[
			"HIDDEN_VALUE_WRITER_TYPE_MISMATCH",
			{ reason: "clock-lost", property: "seen_at", clockSource: "stamp" },
			'"visit_check" saves to "seen_at", which holds dates and times, but its value keeps only the day because "stamp" doesn\'t keep the time. You can save it from a question or now() instead.',
		],
		[
			"HIDDEN_VALUE_WRITER_TYPE_MISMATCH",
			{
				reason: "hidden-disagreement",
				disagreement: "others",
				property: "score",
				valueType: "int",
			},
			'"visit_check" saves a whole number to "score", but other hidden values save a different kind of value there. You can have them all give the same kind, or save this one somewhere else.',
		],
		[
			"HIDDEN_VALUE_WRITER_TYPE_MISMATCH",
			{
				reason: "hidden-disagreement",
				disagreement: "own",
				property: "score",
				valueType: "int",
				valueTypes: "int,text",
			},
			'"visit_check" saves a whole number or text to "score" from different results, so the property has no one kind of value. You can have every result of its calculation give the same kind.',
		],
		[
			"SELECT_PRELOAD_WRITE_NOT_AN_OPTION",
			{
				value: "z",
				property: "stage",
				readerField: "stage_question",
				readerForm: "Visit",
			},
			'"visit_check" saves "z" to "stage", which "stage_question" in "Visit" starts on, but "z" isn\'t one of its choices. You can save one of its choices instead, or save it somewhere else.',
		],
	] as const)("renders %s with %j as its own line", (code, details, line) => {
		expect(userFacingError(finding(code, { ...details }))).toBe(line);
	});

	it("names the starting value a Hidden Value's type comes from", () => {
		expect(
			userFacingError(
				finding(
					"HIDDEN_VALUE_WRITER_TYPE_MISMATCH",
					{ property: "score", valueType: "text", propertyType: "int" },
					{ field: "default_value" },
				),
			),
		).toBe(
			'"visit_check" saves text to "score", which holds whole numbers. You can change its starting value to give a whole number, or save it somewhere else.',
		);
	});

	it("names a case operation that saves a value none of the choices hold", () => {
		expect(
			userFacingError(
				finding(
					"SELECT_PRELOAD_WRITE_NOT_AN_OPTION",
					{
						value: "z",
						property: "stage",
						readerField: "stage_question",
						readerForm: "Visit",
						operationId: "mark_stage",
					},
					{ fieldId: undefined },
				),
			),
		).toMatch(/^The case operation "mark_stage" saves "z" to "stage"/);
	});

	it("explains a case operation value whose clock is gone", () => {
		expect(
			userFacingError(
				finding("CASE_OPERATION_EXPRESSION_TYPE", { reason: "clock-lost" }),
			),
		).toBe(
			"A value in this case operation keeps only the day of a date and time, so saving it here would record midnight instead of the moment. You can save it from a question or now() instead.",
		);
	});

	it("names the menu whose chosen cases a question reads after the form stops working on them", () => {
		expect(
			userFacingError(
				finding(
					"SESSION_DATUM_NOT_SUPPLIED",
					{
						carrier: "field",
						reason: "selected-cases",
						datumKind: "selected-cases",
						datumModuleName: "Households",
					},
					{ fieldUuid: testUuid("user-facing-visit-check") },
				),
			),
		).toBe(
			'"visit_check" reads the cases chosen in "Households", but "Register Client" no longer works on cases chosen there, so CommCare can\'t open the form. You can choose the cases before this form again, or read a question instead.',
		);
	});

	it.each([
		[
			{ carrier: "case-list", reason: "not-before" },
			'The case list of "Clients" reads the case chosen in "Households", but "Clients" no longer opens after "Households", so CommCare has no chosen case to read there. You can open "Clients" from "Households" again, or remove that read.',
		],
		[
			{ carrier: "search", reason: "not-before" },
			'The search in "Clients" reads the case chosen in "Households", but "Clients" no longer opens after "Households", so CommCare has no chosen case to read there. You can open "Clients" from "Households" again, or remove that read.',
		],
		[
			{ carrier: "case-list", reason: "differs", otherModuleName: "Visits" },
			'The case list of "Clients" reads the case chosen in "Households", but "Visits" also shows this list, and there CommCare keeps that choice in another place, so the read would not find that case. You can remove the read, or give "Visits" its own list to choose from.',
		],
		[
			{ carrier: "search", reason: "several-cases" },
			'The search in "Clients" reads the case chosen in "Households", but "Households" now lets workers choose several cases, so there is no one chosen case to read. You can let "Households" choose one case, or remove that read.',
		],
		[
			{ carrier: "form-display-condition", reason: "not-before" },
			'"Register Client" shows only when the case chosen in "Households" matches, but its menu shows before that case is chosen. You can choose the case before this menu, or base the condition on the worker instead.',
		],
	])(
		"says where a record setting reads a chosen case its entries don't hold: %o",
		(details, copy) => {
			expect(
				userFacingError(
					finding("SESSION_DATUM_NOT_SUPPLIED", {
						...details,
						datumKind: "selected-case",
						datumModuleName: "Households",
					}),
				),
			).toBe(copy);
		},
	);

	it.each([
		[
			"epoch-days-not-whole",
			'The condition for search field "Lookup" turns a number with a fraction into a date. CommCare\'s search counts days in whole numbers. Use a whole number of days.',
		],
		[
			"raw-argument-not-evaluated",
			"The condition for search field \"Lookup\" gives the search a value to work out. CommCare's search uses this value as written and won't calculate it. Choose a fixed value or one the device can work out.",
		],
		[
			"value-list-placement",
			"The condition for search field \"Lookup\" compares a list of values in a way CommCare's search can't. A list of values can be compared only as equal or not equal to a case value.",
		],
	])(
		"names a search shape CommCare's search can't read: %s",
		(reason, copy) => {
			expect(
				userFacingError(
					finding("CASE_LIST_CSQL_NOT_REPRESENTABLE", {
						reason,
						inputLabel: "Lookup",
					}),
				),
			).toBe(copy);
		},
	);

	it("names the setting that reads Date closed where a device evaluates it", () => {
		expect(
			userFacingError(
				finding("CASE_LIST_CLOSED_ON_NOT_ON_DEVICE", {
					checkCode: "closed-on-not-on-device",
					slotCode: "CASE_LIST_FILTER_TYPE_ERROR",
				}),
			),
		).toBe(
			"The Cases available setting in \"Clients\" reads Date closed. Date closed is known only to CommCare's server search, so it can't be read here. Case status shows whether a case is closed.",
		);
		expect(
			userFacingError(
				finding("CASE_LIST_CLOSED_ON_NOT_ON_DEVICE", {
					checkCode: "closed-on-not-on-device",
				}),
			),
		).toBe(
			'A formula on "visit_check" in "Register Client" reads Date closed. Date closed is known only to CommCare\'s server search, so it can\'t be read here. Case status shows whether a case is closed.',
		);
	});

	it.each([
		[
			"case-type-ordering",
			'The Cases available setting in "Clients" orders case types. Case types can be compared only as equal or not equal. You can check whether the case type is one you choose.',
		],
		[
			"runtime-selected-value-on-device",
			'The Cases available setting in "Clients" looks for choices named by a value that can hold several of them, which the device reads differently from the server. Choose a single-choice value here, or use it in a search field\'s condition.',
		],
	])(
		"names a search shape a record setting can't hold: %s",
		(checkCode, copy) => {
			expect(
				userFacingError(finding("CASE_LIST_FILTER_TYPE_ERROR", { checkCode })),
			).toBe(copy);
		},
	);

	it("names a link and a CommCare Connect setting as the carrier that reads a form's value", () => {
		const atForm = (
			code: ValidationErrorCode,
			details: Record<string, string>,
			field: string,
		) =>
			userFacingError(
				finding(code, details, {
					fieldId: undefined,
					fieldUuid: undefined,
					field,
				}),
			);
		expect(
			atForm(
				"SEARCH_RESULTS_NOT_SUPPLIED",
				{ reason: "link-source" },
				"form_link_condition",
			),
		).toBe(
			'A link from "Register Client" reads what a search found, but "Register Client" doesn\'t open after a search. You can read a case property instead.',
		);
		expect(
			atForm("LOCATIONS_READ_NEEDS_ORGANIZATION", {}, "deliver_entity_id"),
		).toBe(
			'A CommCare Connect setting of "Register Client" reads places, but this app has no organization yet. You can add your organization\'s levels in App setup first.',
		);
		expect(
			atForm(
				"SESSION_DATUM_NOT_SUPPLIED",
				{
					carrier: "form-link",
					reason: "selected-cases-carrier",
					datumModuleName: "Households",
				},
				"form_link_condition",
			),
		).toBe(
			'A link from "Register Client" reads the cases chosen in "Households", which only the form\'s questions can read while it runs. You can save how many there are to a worker detail in the form and read it with #user/ instead.',
		);
	});

	it("keeps each code's line for a finding without a reason", () => {
		expect(userFacingError(finding("TYPE_ERROR", {}))).toBe(
			'A formula on "visit_check" in "Register Client" uses text where it needs a number, so the result might come out wrong. Check the values it\'s working with.',
		);
		expect(
			userFacingError(finding("XPATH_FUNCTION_CONTEXT_UNAVAILABLE", {})),
		).toBe(
			"A function in a formula needs information that isn't available here. Use it where that information is available, or rewrite the formula.",
		);
	});
});

describe("the session and search reads a form makes, in the builder's voice", () => {
	const VISIT_CHECK = testUuid("user-facing-reads-visit-check");
	function read(
		code: ValidationErrorCode,
		details: Record<string, string>,
		location: Partial<ValidationError["location"]> = {},
	): ValidationError {
		return validationError(
			code,
			"field",
			"internal implementation detail",
			{
				moduleName: "Clients",
				formName: "Register Client",
				fieldUuid: VISIT_CHECK,
				fieldId: "visit_check",
				field: "calculate",
				...location,
			},
			details,
		);
	}

	it.each([
		[
			"XPATH_FUNCTION_CONTEXT_UNAVAILABLE",
			{ reason: "window-width" },
			'A formula on "visit_check" in "Register Client" reads the window width, which CommCare sends only while a menu or a list loads, so a form can\'t rely on it. You can use it in a display condition or a case list instead.',
		],
		[
			"XPATH_FUNCTION_CONTEXT_UNAVAILABLE",
			{ reason: "case-list-search-text-slot" },
			'A formula on "visit_check" in "Register Client" reads what the worker typed into a case list\'s search box, which only a form\'s questions and Connect settings can read. You can read it in one of the form\'s questions instead.',
		],
		[
			"XPATH_FUNCTION_CONTEXT_UNAVAILABLE",
			{
				reason: "platform-unavailable",
				feature: "case-list-search-text",
				platform: "web-apps",
			},
			'A formula on "visit_check" in "Register Client" reads the case list\'s search text, which Web Apps doesn\'t keep. You can take it out, or set the app to run only on Android in App settings.',
		],
		[
			"XPATH_FUNCTION_CONTEXT_UNAVAILABLE",
			{
				reason: "platform-unavailable",
				feature: "window-width",
				platform: "android",
			},
			'A formula on "visit_check" in "Register Client" reads the window width, which Android doesn\'t have. You can take it out, or set the app to run only in Web Apps in App settings.',
		],
		[
			"SESSION_DATUM_NOT_SUPPLIED",
			{ carrier: "field", reason: "case-list-search-text", caseLists: "0" },
			'"visit_check" reads what the worker typed into a case list\'s search box, but "Register Client" doesn\'t open after a case list. You can read a question or a case property instead.',
		],
		[
			"SESSION_DATUM_NOT_SUPPLIED",
			{ carrier: "field", reason: "case-list-search-text", caseLists: "2" },
			'"visit_check" reads what the worker typed into a case list\'s search box, but "Register Client" opens after 2 case lists, so CommCare can\'t tell which search it means. You can read it in a form that opens after one case list.',
		],
		[
			"INVALID_SEARCH_REF",
			{ reason: "not-search-first" },
			'"visit_check" in "Register Client" reads a search answer this form can\'t get to. Only a form in a menu that opens on its search can read that menu\'s Search fields. You can turn Search first back on, or read a question or a case property instead.',
		],
		[
			"INVALID_SEARCH_REF",
			{ reason: "form-link" },
			'A link from "Register Client" reads a search answer after the form has closed, where CommCare no longer holds it. You can save the answer to a question in the form and read that instead.',
		],
		[
			"INVALID_SEARCH_REF",
			{},
			'"visit_check" in "Register Client" reads a search answer this form can\'t get to. Only a form that opens after its menu\'s search can read that menu\'s Search fields.',
		],
	] as const)("renders %s with %j as its own line", (code, details, line) => {
		expect(userFacingError(read(code, { ...details }))).toBe(line);
	});
});
