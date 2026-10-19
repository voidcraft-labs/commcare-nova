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
