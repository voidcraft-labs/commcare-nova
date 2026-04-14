import { describe, expect, it } from "vitest";
import { q } from "@/lib/__tests__/testHelpers";
import {
	type AppBlueprint,
	appBlueprintSchema,
	type Question,
} from "../blueprint";

/** Minimal blueprint wrapping the given questions into a single form. */
function wrapQuestions(questions: Question[]): AppBlueprint {
	return {
		app_name: "Test",
		modules: [
			{
				uuid: "module-1-uuid",
				name: "M1",
				forms: [
					{
						uuid: "form-1-uuid",
						name: "F1",
						type: "survey" as const,
						questions,
					},
				],
			},
		],
		case_types: null,
	};
}

describe("appBlueprintSchema recursive questions", () => {
	it("accepts three levels of nesting and preserves all children", () => {
		const blueprint = wrapQuestions([
			q({
				id: "outer",
				type: "group",
				children: [
					q({
						id: "middle",
						type: "group",
						children: [
							q({
								id: "inner",
								type: "text",
								label: "Deeply nested",
							}),
						],
					}),
				],
			}),
		]);

		const result = appBlueprintSchema.safeParse(blueprint);

		expect(result.success).toBe(true);
		const questions = result.data?.modules[0].forms[0].questions;
		if (!questions) throw new Error("Expected questions");
		expect(questions[0].children?.[0].children?.[0]).toMatchObject({
			id: "inner",
			type: "text",
			label: "Deeply nested",
		});
	});
});
