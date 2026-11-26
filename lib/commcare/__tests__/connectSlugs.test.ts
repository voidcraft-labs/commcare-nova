import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseFixtureExpression } from "@/lib/__tests__/docHelpers";
import { runValidation } from "@/lib/commcare/validator/runner";
import { parseFormExpression } from "@/lib/commcare/xpath/expressionAst";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type ConnectActivity,
	connectActivityIdLimit,
	freeConnectId,
} from "@/lib/domain/fields/connectActivity";
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

describe("Connect identity and role admission", () => {
	it.each([
		"bad id",
		"1leading",
		"_leading",
		"XMLquiz",
		"task",
		"a".repeat(51),
	])("refuses the submitted lesson id %j without changing it", (id) => {
		const { doc } = fixture("learn-default");
		const lesson = Object.values(doc.fields).find(
			(field) => field.id === "lesson",
		);
		if (lesson?.kind !== "connect_activity")
			throw new Error("Expected a lesson");
		lesson.id = id;
		const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		expect(
			findings.some(
				(finding) =>
					finding.code ===
					(id.length > 50
						? "CONNECT_ID_TOO_LONG"
						: "CONNECT_ID_INVALID_FORMAT"),
			),
		).toBe(true);
		expect(lesson.id).toBe(id);
	});
	it("keeps the submitted lesson and assessment until their author removes them", () => {
		const { doc } = fixture("learn-default");
		doc.connectRoles = ["deliver"];
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
				(finding) => finding.code === "CONNECT_MODE_MISMATCH",
			),
		).toHaveLength(2);
		doc.connectRoles = ["learn", "deliver"];
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	});
});

describe("a replacement for a positioned activity ID", () => {
	it.each([
		"learning-module",
		"assigned-task",
		"assessment",
		"delivery",
	] as const)(
		"offers a free, editor-stable %s ID within its own receiver width",
		(kind: ConnectActivity["kind"]) => {
			const limit = connectActivityIdLimit(kind);
			const long = "a".repeat(120);
			const first = freeConnectId(long, new Set(), kind);
			expect(first.length).toBe(limit ?? long.length);
			fc.assert(
				fc.property(
					fc.string(),
					fc.array(fc.string(), { maxLength: 10 }),
					(name, reservations) => {
						const taken = new Set(reservations);
						const answer = freeConnectId(name, taken, kind);
						expect(
							questionIdProblem(answer, RESERVED_CONNECT_BLOCK_IDS),
						).toBeUndefined();
						expect(taken.has(answer)).toBe(false);
						taken.add(answer);
						const next = freeConnectId(name, taken, kind);
						expect(taken.has(next)).toBe(false);
						expect(
							questionIdProblem(next, RESERVED_CONNECT_BLOCK_IDS),
						).toBeUndefined();
						if (limit !== undefined)
							expect(next.length).toBeLessThanOrEqual(limit);
					},
				),
				{ seed: 648201, numRuns: 100 },
			);
		},
	);
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
