/**
 * Sections make "a sectioned form" a closed state: a section sits at the
 * form's top level, a form with a section at its root has only sections
 * there, and no repeat the worker grows by hand lives under a section.
 *
 * The three facts behind the rules are the CommCare app's: a field-list
 * group is one screen (`FormEntryController::getQuestionPrompts` returns
 * every descendant question of the host), nested field-lists flatten onto
 * the outer screen with no separator, and the app adds repeat entries only
 * from a screen of its own (`EVENT_PROMPT_NEW_REPEAT` is never raised inside
 * a field-list host, so an add-entries repeat there is unreachable).
 */

import { describe, expect, it } from "vitest";
import { buildDoc, type FieldSpec, f, xp } from "@/lib/__tests__/docHelpers";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { proseText } from "@/lib/domain/prose";
import { runValidation } from "../runner";

const SECTION_CODES = new Set([
	"FORM_SECTION_NOT_TOP_LEVEL",
	"FORM_SECTIONS_INCOMPLETE",
	"FORM_SECTION_USER_REPEAT",
]);

function text(id: string): FieldSpec {
	return f({ kind: "text", id, label: proseText(id) });
}

function section(id: string, children: FieldSpec[], label?: string): FieldSpec {
	return f({
		kind: "section",
		id,
		...(label !== undefined && { label: proseText(label) }),
		children,
	});
}

function userRepeat(id: string, children: FieldSpec[] = []): FieldSpec {
	return f({
		kind: "repeat",
		id,
		label: proseText(id),
		repeat_mode: "user_controlled",
		children,
	});
}

function sectionFindings(fields: FieldSpec[]) {
	const doc = buildDoc({
		appName: "Sections",
		modules: [
			{ name: "Visits", forms: [{ name: "Visit", type: "survey", fields }] },
		],
	});
	return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) =>
		SECTION_CODES.has(e.code),
	);
}

describe("form sections", () => {
	it("says nothing about a sectionless form", () => {
		expect(
			sectionFindings([
				text("name"),
				f({
					kind: "group",
					id: "g",
					label: proseText("G"),
					children: [text("a")],
				}),
				userRepeat("visits", [text("date")]),
			]),
		).toEqual([]);
	});

	it("accepts a form whose root is sections only", () => {
		expect(
			sectionFindings([
				section("intro", [text("name"), text("age")], "About you"),
				section("visit", [text("date")]),
			]),
		).toEqual([]);
	});

	it("accepts an empty section", () => {
		expect(
			sectionFindings([section("intro", [text("name")]), section("empty", [])]),
		).toEqual([]);
	});

	it("refuses a root that mixes sections and loose fields, naming the loose ones", () => {
		const findings = sectionFindings([
			section("intro", [text("name")]),
			text("stray"),
			f({
				kind: "group",
				id: "g",
				label: proseText("G"),
				children: [text("a")],
			}),
		]);
		expect(findings.map((e) => e.code)).toEqual(["FORM_SECTIONS_INCOMPLETE"]);
		const [finding] = findings;
		expect(finding?.scope).toBe("form");
		expect(finding?.message).toContain('"stray", "g"');
		expect(finding?.message).toContain("2 fields sit");
		expect(finding?.details?.looseCount).toBe("2");
		expect(finding?.details?.looseFieldIds).toBe("stray,g");
		expect(finding?.details?.looseFieldUuids?.split(",")).toHaveLength(2);
	});

	it("speaks in the singular for one loose field", () => {
		const [finding] = sectionFindings([
			section("intro", [text("name")]),
			text("stray"),
		]);
		expect(finding?.message).toContain("1 field sits");
		expect(finding?.message).toContain("Add it to a section");
	});

	it("refuses a section inside a group, a repeat, or another section, once per offender", () => {
		const findings = sectionFindings([
			section("outer", [
				section("inner", [text("a")]),
				f({
					kind: "group",
					id: "g",
					label: proseText("G"),
					children: [section("in_group", [])],
				}),
				f({
					kind: "repeat",
					id: "r",
					label: proseText("R"),
					repeat_mode: "count_bound",
					repeat_count: xp("2"),
					children: [section("in_repeat", [])],
				}),
			]),
		]);
		const nested = findings.filter(
			(e) => e.code === "FORM_SECTION_NOT_TOP_LEVEL",
		);
		expect(nested.map((e) => e.location.fieldId).sort()).toEqual([
			"in_group",
			"in_repeat",
			"inner",
		]);
		for (const finding of nested) expect(finding.scope).toBe("field");
		const inner = nested.find((e) => e.location.fieldId === "inner");
		expect(inner?.message).toContain('inside section "outer"');
		expect(inner?.details).toMatchObject({
			parentId: "outer",
			parentKind: "section",
		});
		const inGroup = nested.find((e) => e.location.fieldId === "in_group");
		expect(inGroup?.message).toContain('inside group "g"');
		expect(inGroup?.details).toMatchObject({
			parentId: "g",
			parentKind: "group",
		});
		expect(
			findings.filter((e) => e.code !== "FORM_SECTION_NOT_TOP_LEVEL"),
		).toEqual([]);
	});

	it("refuses an add-entries repeat under a section at any depth, naming the page", () => {
		const findings = sectionFindings([
			section("intro", [userRepeat("shallow", [text("a")])], "About you"),
			section("visit", [
				f({
					kind: "group",
					id: "g",
					label: proseText("G"),
					children: [
						f({
							kind: "group",
							id: "gg",
							label: proseText("GG"),
							children: [userRepeat("deep", [text("b")])],
						}),
					],
				}),
			]),
		]);
		expect(findings.map((e) => e.code)).toEqual([
			"FORM_SECTION_USER_REPEAT",
			"FORM_SECTION_USER_REPEAT",
		]);
		const shallow = findings.find((e) => e.location.fieldId === "shallow");
		expect(shallow?.scope).toBe("field");
		expect(shallow?.message).toContain('inside section "About you"');
		expect(shallow?.details).toMatchObject({
			sectionId: "intro",
			sectionTitle: "About you",
		});
		const deep = findings.find((e) => e.location.fieldId === "deep");
		expect(deep?.message).toContain('inside section "visit"');
		expect(deep?.details?.sectionTitle).toBe("visit");
	});

	it("accepts count-bound and query-bound repeats under a section", () => {
		expect(
			sectionFindings([
				section("visit", [
					f({
						kind: "repeat",
						id: "fixed",
						label: proseText("Fixed"),
						repeat_mode: "count_bound",
						repeat_count: xp("3"),
						children: [text("a")],
					}),
					f({
						kind: "repeat",
						id: "per_case",
						label: proseText("Per case"),
						repeat_mode: "query_bound",
						data_source: {
							ids_query: xp("instance('casedb')/casedb/case/@case_id"),
						},
						children: [text("b")],
					}),
				]),
			]),
		).toEqual([]);
	});

	it("reads a form of only empty pages as an empty form", () => {
		const doc = buildDoc({
			appName: "Sections",
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [section("s1", [], "First"), section("s2", [])],
						},
					],
				},
			],
		});
		const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		const empty = findings.find((e) => e.code === "EMPTY_FORM");
		expect(empty?.message).toContain("nothing on any of them");
		// One question on any page is a buildable form again.
		const withQuestion = buildDoc({
			appName: "Sections",
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [section("s1", [text("q")], "First"), section("s2", [])],
						},
					],
				},
			],
		});
		expect(
			runValidation(withQuestion, LOOKUP_CONTEXT_UNAVAILABLE).filter(
				(e) => e.code === "EMPTY_FORM",
			),
		).toEqual([]);
	});

	it("reports a nested section and the add-entries repeat it holds as two findings", () => {
		const findings = sectionFindings([
			section("outer", [
				f({
					kind: "group",
					id: "g",
					label: proseText("G"),
					children: [section("inner", [userRepeat("r")])],
				}),
			]),
		]);
		expect(findings.map((e) => e.code).sort()).toEqual([
			"FORM_SECTION_NOT_TOP_LEVEL",
			"FORM_SECTION_USER_REPEAT",
		]);
		// The repeat names the page it is on (the root section), not the
		// nested one: moving it out of "inner" would not free it.
		const repeat = findings.find((e) => e.code === "FORM_SECTION_USER_REPEAT");
		expect(repeat?.details?.sectionId).toBe("outer");
	});
});
