import { describe, expect, it } from "vitest";
import { expressionEditorFixture } from "@/__tests__/helpers/expressionEditorFixture";
import {
	checkExpression,
	count,
	eq,
	exists,
	expressionSchema,
	literal,
	missing,
	type PropertyRef,
	prop,
	type RelationPath,
	subcasePath,
} from "@/lib/domain/expression";
import { proseText } from "@/lib/domain/prose";
import { editorExpressionContext } from "../editorTypeContext";
import {
	relatedPathEditAdmission,
	replacePropertyRelation,
	replaceRelatedPath,
} from "../relatedPathEdit";

const vocabulary = {
	currentCaseType: "household",
	knownInputs: [],
	caseTypes: [
		{ name: "household", properties: [] },
		{
			name: "patient",
			parent_type: "household",
			properties: [
				{
					name: "enrollment",
					label: proseText("Enrollment"),
					data_type: "text" as const,
				},
			],
		},
		{
			name: "visit",
			parent_type: "household",
			properties: [
				{
					name: "enrollment",
					label: proseText("Enrollment"),
					data_type: "text" as const,
				},
			],
		},
	],
} satisfies Parameters<typeof expressionEditorFixture>[1];
const original = subcasePath("parent", "patient");
const next = subcasePath("parent", "visit");
const where = eq(prop("patient", "enrollment"), literal("active"));
describe("related connection edits preserve admitted filters", () => {
	for (const kind of ["count", "exists", "missing"] as const) {
		const ctx = expressionEditorFixture(
			kind === "count" ? "calculated-column" : "case-filter",
			vocabulary,
		).context;
		const builder =
			kind === "count" ? count : kind === "exists" ? exists : missing;
		it(`${kind} refuses a connection that invalidates a saved condition`, () => {
			const value = builder(original, where);
			const verdict =
				value.kind === "count"
					? checkExpression(
							expressionSchema.parse(value),
							editorExpressionContext(ctx),
						)
					: checkExpression(
							expressionSchema.parse(value),
							editorExpressionContext(ctx),
						);
			expect(verdict).toMatchObject({ errors: [] });
			expect(relatedPathEditAdmission(value, next, ctx)).toMatchObject({
				admitted: false,
			});
			expect(value.where).toBe(where);
		});
		it(`${kind} keeps a compatible filter and permits an unfiltered destination change`, () => {
			const value = builder(original, where);
			expect(relatedPathEditAdmission(value, original, ctx)).toEqual({
				admitted: true,
			});
			expect(replaceRelatedPath(value, original).where).toBe(where);
			const changed = replaceRelatedPath(builder(original), next);
			expect(changed).toEqual(builder(next));
			expect(changed).not.toHaveProperty("where");
			expect(relatedPathEditAdmission(builder(original), next, ctx)).toEqual({
				admitted: true,
			});
		});
	}
});

describe("a property read's relation changed in the Builder", () => {
	// A translated relation column brought in from CommCare HQ holds a read of
	// whatever case its link reaches (`readReached`). The read keeps that only
	// while its relation still walks up links; on any other relation the
	// schema refuses the flag, so the author's edit would be refused with a
	// message about a flag they never see.
	const reached = {
		kind: "prop" as const,
		caseType: "patient",
		property: "enrollment",
		via: {
			kind: "ancestor" as const,
			via: [{ identifier: "parent" }] as [{ identifier: string }],
		},
		readReached: true as const,
	} satisfies PropertyRef;
	const parses = (term: PropertyRef) =>
		expressionSchema.safeParse({ kind: "term", term }).success;
	it("keeps the reached read over another walk up its links", () => {
		const host: RelationPath = {
			kind: "ancestor",
			via: [{ identifier: "host" }, { identifier: "parent" }],
		};
		const changed = replacePropertyRelation(reached, host);
		expect(changed).toEqual({ ...reached, via: host });
		expect(parses(changed)).toBe(true);
	});
	it.each([
		["this case", { kind: "self" }],
		["a child case", subcasePath("visit")],
	] satisfies [string, RelationPath][])(
		"reads %s as an ordinary read",
		(_label, via) => {
			const changed = replacePropertyRelation(reached, via);
			expect(changed).toEqual({
				kind: "prop",
				caseType: "patient",
				property: "enrollment",
				via,
			});
			expect(parses(changed)).toBe(true);
		},
	);
});
