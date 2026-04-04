import { describe, expect, it } from "vitest";
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
				name: "M1",
				forms: [{ name: "F1", type: "survey" as const, questions }],
			},
		],
		case_types: null,
	};
}

describe("appBlueprintSchema recursive questions", () => {
	it("accepts three levels of nesting and preserves all children", () => {
		const blueprint = wrapQuestions([
			{
				id: "outer",
				type: "group",
				children: [
					{
						id: "middle",
						type: "group",
						children: [
							{
								id: "inner",
								type: "text",
								label: "Deeply nested",
							},
						],
					},
				],
			},
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
