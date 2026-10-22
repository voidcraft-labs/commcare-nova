import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseFixtureExpression } from "@/lib/__tests__/docHelpers";
import {
	buildConnectSlugMap,
	connectIdConflictError,
	connectIdError,
	deriveConnectId,
} from "@/lib/commcare/connectSlugs";
import { expandDoc } from "@/lib/commcare/expander";
import { runValidation } from "@/lib/commcare/validator/runner";
import { parseFormExpression } from "@/lib/commcare/xpath/expressionAst";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	questionIdProblem,
	RESERVED_CONNECT_BLOCK_IDS,
} from "@/lib/domain/questionId";
import { connectWireFixtures } from "./connectWireFixtures";

function fixture(name: string) {
	const found = connectWireFixtures().find((fixture) => fixture.name === name);
	if (!found) throw new Error(name);
	const formUuid = found.doc.formOrder[found.doc.moduleOrder[0]][0];
	return { ...found, formUuid, form: found.doc.forms[formUuid] };
}

// These are private identity-policy and defensive compiler assertions. They do
// not establish external acceptance; Connect's native consumer owns that proof.
describe("Connect identity projection", () => {
	it.each(["learn-default", "deliver-default", "absent"])(
		"%s keeps complete stored identities and does not mutate its source",
		(name) => {
			const { doc } = fixture(name);
			const before = structuredClone(doc);
			const result = buildConnectSlugMap(doc);
			expect([...result]).toEqual(
				doc.formOrder[doc.moduleOrder[0]].flatMap((formUuid) => {
					const connect = doc.forms[formUuid].connect;
					return connect ? [[formUuid, connect]] : [];
				}),
			);
			expect(doc).toEqual(before);
		},
	);

	it.each([
		"",
		"bad id",
		"1leading",
		"_leading",
		"XMLquiz",
		"task",
		"a".repeat(51),
	])("refuses a forged invalid final id %j instead of repairing it", (id) => {
		const { doc, form } = fixture("learn-default");
		if (
			!form.connect ||
			!("learn_module" in form.connect) ||
			!form.connect.learn_module
		)
			throw new Error("Missing lesson");
		form.connect.learn_module.id = id;
		expect(() => buildConnectSlugMap(doc)).toThrow(/invalid final id/);
		expect(() => expandDoc(doc)).toThrow(/invalid final id/);
	});

	it("refuses two blocks sharing a final id, including different block kinds", () => {
		const { doc, form } = fixture("learn-default");
		if (
			!form.connect ||
			!("assessment" in form.connect) ||
			!form.connect.assessment
		)
			throw new Error("Missing quiz");
		form.connect.assessment.id = "lesson";
		expect(() => buildConnectSlugMap(doc)).toThrow(
			/Two Connect blocks share the id "lesson"/,
		);
	});

	it.each([null, "deliver"] as const)(
		"refuses learned blocks after a forged app-mode change to %s",
		(mode) => {
			const { doc } = fixture("learn-default");
			doc.connectType = mode;
			expect(() => buildConnectSlugMap(doc)).toThrow(
				mode === null ? /no Connect mode/ : /wrong app mode/,
			);
		},
	);
});

describe("Connect creation identity policy", () => {
	it.each([
		"2024 Intake",
		"has space",
		"1st_module",
		"bad-dash",
		"",
		"_leading_underscore",
		"XMLquiz",
		"Meta",
		"case",
		"parsererror",
		"a".repeat(51),
	])("explains invalid id %j", (id) => {
		expect(connectIdError(id)).toEqual(expect.any(String));
	});
	it.each([
		"intake_2024",
		"xmlquiz",
		"metadata",
		"tasks",
		"Task",
		"Module",
		"q_deliver",
		"a".repeat(50),
	])("accepts %j", (id) => {
		expect(connectIdError(id)).toBeNull();
	});
	it.each(["assessment", "deliver", "module", "task", "work_area_update"])(
		"refuses %j, a name Connect's receiver keeps for itself",
		(id) => {
			expect(connectIdError(id)).toBe(
				`"${id}" is a name CommCare Connect keeps for itself, and it can't receive a form whose block is called that. "q_${id}" is free here.`,
			);
		},
	);
	it("offers a replacement free among the app's other Connect ids", () => {
		expect(connectIdError("_lesson", new Set(["lesson"]))).toBe(
			"A Connect ID can't start with an underscore, because CommCare HQ's form builder can't keep it. \"lesson_2\" is free here.",
		);
		// The replacement is cut at the tail so its suffix fits the cap.
		const long = `_1st_lesson${"x".repeat(39)}`;
		const migrated = `q1st_lesson${"x".repeat(39)}`;
		expect(migrated).toHaveLength(50);
		expect(connectIdError(long)).toContain(`"${migrated}" is free here.`);
		expect(connectIdError(long, new Set([migrated]))).toContain(
			`"${migrated.slice(0, 48)}_2" is free here.`,
		);
	});
	it("only rejects explicit identities that another block owns", () => {
		expect(
			connectIdConflictError("intro", new Set(["intro", "other"])),
		).toContain("already used");
		expect(connectIdConflictError("intro", new Set(["other"]))).toBeNull();
	});
	it("mints a letter-first id and never one of Connect's own names", () => {
		expect(deriveConnectId("1st visit", new Set())).toBe("q1st_visit");
		expect(deriveConnectId("1st visit", new Set(["q1st_visit"]))).toBe(
			"q1st_visit_2",
		);
		expect(deriveConnectId("Task", new Set())).toBe("q_task");
		expect(deriveConnectId("Work area update", new Set())).toBe(
			"q_work_area_update",
		);
		expect(deriveConnectId("XML quiz", new Set())).toBe("xml_quiz");
		expect(deriveConnectId("Meta", new Set())).toBe("q_meta");
		const long = deriveConnectId(`1 ${"x".repeat(60)}`, new Set());
		expect(long).toHaveLength(50);
		expect(long.startsWith("q1_")).toBe(true);
	});
	it("derives the first available suffix across digit and length boundaries", () => {
		expect(deriveConnectId("Module 3 Intro", new Set())).toBe("module_3_intro");
		const base = "a".repeat(50);
		const taken = new Set([base]);
		for (let n = 2; n <= 101; n++) {
			const suffix = `_${n}`;
			const expected = base.slice(0, 50 - suffix.length) + suffix;
			expect(deriveConnectId(base, taken)).toBe(expected);
			taken.add(expected);
		}
	});
	it("constructs a bounded fresh editor-safe identity from arbitrary names without changing reservations", () => {
		fc.assert(
			fc.property(
				fc.string(),
				fc.array(fc.string(), { maxLength: 10 }),
				(name, reservations) => {
					const initial = new Set(reservations);
					const first = deriveConnectId(name, initial);
					expect(
						questionIdProblem(first, RESERVED_CONNECT_BLOCK_IDS),
					).toBeUndefined();
					expect(first.length).toBeLessThanOrEqual(50);
					expect(initial.has(first)).toBe(false);
					expect([...initial]).toEqual([...new Set(reservations)]);
					const occupied = new Set([...initial, first]);
					const second = deriveConnectId(name, occupied);
					expect(occupied.has(second)).toBe(false);
					expect(
						questionIdProblem(second, RESERVED_CONNECT_BLOCK_IDS),
					).toBeUndefined();
					expect(second.length).toBeLessThanOrEqual(50);
				},
			),
			{ seed: 648201, numRuns: 100 },
		);
	});
});

describe("Connect data paths in validator admission", () => {
	// A deliver app's task sits in the menu's second form, beside a label.
	it.each([
		["learn-default", 0, "lesson"],
		["deliver-default", 1, "follow_up"],
	] as const)(
		"%s admits the actual wrapper and identifies a missing wrapper",
		(name, formIndex, wrapper) => {
			const { doc } = fixture(name);
			const formUuid = doc.formOrder[doc.moduleOrder[0]][formIndex];
			const field = doc.fields[doc.fieldOrder[formUuid][0]];
			if (field.kind !== "int" && field.kind !== "label")
				throw new Error("Expected the form's first question or label");
			const slot = {
				entity: "field",
				uuid: field.uuid,
				slot: "relevant",
			} as const;
			field.relevant = parseFixtureExpression(doc, slot, `../${wrapper} = 'x'`);
			expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
			const parsed = parseFormExpression("../no_such_connect_node = 'x'", {
				doc,
				slot,
				lookup: "unavailable",
			});
			expect(parsed).toMatchObject({
				ok: false,
				issues: [{ code: "relative-unknown" }],
			});
		},
	);
});
