import { describe, it, expect } from "vitest";
import { flattenQuestionPaths } from "../questionNavigation";
import { qpath } from "../questionPath";

// Use plain objects — the function only reads id, type, and children
type Q = { id: string; type: string; children?: Q[] };

describe("flattenQuestionPaths", () => {
	it("returns flat list for simple questions", () => {
		const questions: Q[] = [
			{ id: "q1", type: "text" },
			{ id: "q2", type: "int" },
			{ id: "q3", type: "date" },
		];
		expect(flattenQuestionPaths(questions)).toEqual([
			qpath("q1"),
			qpath("q2"),
			qpath("q3"),
		]);
	});

	it("skips hidden questions", () => {
		const questions: Q[] = [
			{ id: "q1", type: "text" },
			{ id: "h1", type: "hidden" },
			{ id: "q2", type: "text" },
		];
		expect(flattenQuestionPaths(questions)).toEqual([qpath("q1"), qpath("q2")]);
	});

	it("includes group/repeat IDs and recurses into children", () => {
		const questions: Q[] = [
			{ id: "q1", type: "text" },
			{
				id: "grp",
				type: "group",
				children: [
					{ id: "child1", type: "text" },
					{ id: "child2", type: "int" },
				],
			},
			{ id: "q2", type: "text" },
		];
		expect(flattenQuestionPaths(questions)).toEqual([
			qpath("q1"),
			qpath("grp"),
			qpath("child1", qpath("grp")),
			qpath("child2", qpath("grp")),
			qpath("q2"),
		]);
	});

	it("handles nested groups", () => {
		const questions: Q[] = [
			{
				id: "outer",
				type: "group",
				children: [
					{
						id: "inner",
						type: "repeat",
						children: [{ id: "deep", type: "text" }],
					},
				],
			},
		];
		expect(flattenQuestionPaths(questions)).toEqual([
			qpath("outer"),
			qpath("inner", qpath("outer")),
			qpath("deep", qpath("inner", qpath("outer"))),
		]);
	});

	it("returns empty array for empty questions", () => {
		expect(flattenQuestionPaths([])).toEqual([]);
	});
});
