import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	caseOperationIdNameProblem,
	caseOperationLinkNameProblem,
	editorSafeQuestionId,
	formBuilderCaseAction,
	QUESTION_ID_PATTERN,
	questionIdProblem,
	RESERVED_CONNECT_BLOCK_IDS,
	RESERVED_QUESTION_IDS,
	sourceWritePropertyProblem,
	stopsFormBuilder,
} from "../questionId";

describe("questionIdProblem", () => {
	it.each([
		["_notes", "leading-underscore"],
		["__nova_x", "leading-underscore"],
		["_1st", "leading-underscore"],
		["1st", "not-letter-first"],
		["", "not-letter-first"],
		["first-name", "characters"],
		["first name", "characters"],
		["XMLcode", "xml-prefix"],
		["XML", "xml-prefix"],
		["Meta", "reserved-name"],
		["meta", "reserved-name"],
		["Case", "reserved-name"],
		["REGISTRATION", "reserved-name"],
		["script", "reserved-name"],
		["instance", "reserved-name"],
		["bind", "reserved-name"],
		["parsererror", "reserved-name"],
	])("refuses %j as %s", (id, problem) => {
		expect(questionIdProblem(id)).toBe(problem);
		// The pattern is the grammar; the reserved names pass it.
		expect(QUESTION_ID_PATTERN.test(id)).toBe(problem === "reserved-name");
	});

	it.each([
		"notes",
		"xmlcode",
		"XmLcode",
		"metadata",
		"cases",
		"registrations",
		"scripts",
		"instances",
		"Instance",
		"Bind",
		"PARSERERROR",
		"itext",
		"task",
	])("accepts %j", (id) => {
		expect(questionIdProblem(id)).toBeUndefined();
	});

	it("refuses Connect's own names only when they are passed, and exactly", () => {
		for (const name of RESERVED_CONNECT_BLOCK_IDS.exact) {
			expect(questionIdProblem(name)).toBeUndefined();
			expect(questionIdProblem(name, RESERVED_CONNECT_BLOCK_IDS)).toBe(
				"reserved-name",
			);
		}
		expect(
			questionIdProblem("Task", RESERVED_CONNECT_BLOCK_IDS),
		).toBeUndefined();
		expect(
			questionIdProblem("tasks", RESERVED_CONNECT_BLOCK_IDS),
		).toBeUndefined();
	});

	// The controls `targeted-reserved-node-names`,
	// `targeted-parsererror-node-name` and `targeted-reserved-question-names`
	// keep what HQ's form builder does with each of these names. Removing one
	// here is a reviewed change.
	it("pins the reserved names", () => {
		expect([...RESERVED_QUESTION_IDS.anyCase]).toEqual([
			"meta",
			"case",
			"registration",
			"script",
		]);
		expect([...RESERVED_QUESTION_IDS.exact]).toEqual([
			"instance",
			"bind",
			"parsererror",
		]);
		expect([...RESERVED_CONNECT_BLOCK_IDS.exact]).toEqual([
			"assessment",
			"deliver",
			"module",
			"task",
			"work_area_update",
		]);
		expect(RESERVED_CONNECT_BLOCK_IDS.anyCase.size).toBe(0);
	});
});

describe("editorSafeQuestionId", () => {
	it.each([
		["_notes", "notes"],
		["_1st", "q1st"],
		["_1st_visit", "q1st_visit"],
		["XMLcode", "qXMLcode"],
		["Meta", "q_Meta"],
		["meta", "q_meta"],
		["case", "q_case"],
		["instance", "q_instance"],
		["first name", "first_name"],
		["", "q"],
		["___", "q"],
		["notes", "notes"],
	])("turns %j into %j", (id, safe) => {
		expect(editorSafeQuestionId(id)).toBe(safe);
	});

	it("avoids the extra names it is handed", () => {
		expect(editorSafeQuestionId("task")).toBe("task");
		expect(editorSafeQuestionId("task", RESERVED_CONNECT_BLOCK_IDS)).toBe(
			"q_task",
		);
	});

	it("always answers an id the grammar admits", () => {
		fc.assert(
			fc.property(fc.string(), fc.boolean(), (id, connect) => {
				const reserved = connect ? RESERVED_CONNECT_BLOCK_IDS : undefined;
				expect(
					questionIdProblem(editorSafeQuestionId(id, reserved), reserved),
				).toBeUndefined();
			}),
			{ seed: 1015, numRuns: 300 },
		);
	});
});

describe("names inside a form's Save to Case blocks", () => {
	it("stops the form builder on exactly the three names", () => {
		for (const name of ["instance", "bind", "parsererror"])
			expect(stopsFormBuilder(name)).toBe(true);
		for (const name of ["Instance", "_instance", "itext", "meta", "close"])
			expect(stopsFormBuilder(name)).toBe(false);
	});

	it("reads close and create as the block's action, and nothing else", () => {
		expect(formBuilderCaseAction("close")).toBe("close");
		expect(formBuilderCaseAction("create")).toBe("create");
		for (const name of ["update", "index", "attachment", "Close", "closed"])
			expect(formBuilderCaseAction(name)).toBeUndefined();
	});

	it("refuses a written property for the three names and close", () => {
		expect(sourceWritePropertyProblem("bind")).toBe("stops_form_builder");
		expect(sourceWritePropertyProblem("close")).toBe("closes_case");
		expect(sourceWritePropertyProblem("closed_on_visit")).toBeUndefined();
	});

	it("refuses an operation id for the three names only, and a link for close and create too", () => {
		expect(caseOperationIdNameProblem("instance")).toBe("stops_form_builder");
		expect(caseOperationIdNameProblem("close")).toBeUndefined();
		expect(caseOperationIdNameProblem("_close")).toBeUndefined();
		expect(caseOperationLinkNameProblem("parsererror")).toBe(
			"stops_form_builder",
		);
		expect(caseOperationLinkNameProblem("create")).toBe("reads_as_case_action");
		expect(caseOperationLinkNameProblem("_parent")).toBeUndefined();
	});
});
