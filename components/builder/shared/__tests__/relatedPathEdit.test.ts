import { describe, expect, it } from "vitest";
import {
	checkPredicate,
	checkValueExpression,
	count,
	eq,
	exists,
	literal,
	missing,
	predicateSchema,
	prop,
	subcasePath,
	valueExpressionSchema,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { buildEditorTypeContext } from "../editorTypeContext";
import {
	relatedPathEditAdmission,
	replaceRelatedPath,
} from "../relatedPathEdit";

const ctx = {
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
};
const original = subcasePath("parent", "patient");
const next = subcasePath("parent", "visit");
const where = eq(prop("patient", "enrollment"), literal("active"));
describe("related connection edits preserve admitted filters", () => {
	for (const kind of ["count", "exists", "missing"] as const) {
		const builder =
			kind === "count" ? count : kind === "exists" ? exists : missing;
		it(`${kind} refuses a connection that invalidates a saved condition`, () => {
			const value = builder(original, where);
			const verdict =
				value.kind === "count"
					? checkValueExpression(
							valueExpressionSchema.parse(value),
							buildEditorTypeContext(ctx),
						)
					: checkPredicate(
							predicateSchema.parse(value),
							buildEditorTypeContext(ctx),
						);
			expect(verdict).toMatchObject({ ok: true });
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
