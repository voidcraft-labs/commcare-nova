import { describe, expect, it } from "vitest";
import {
	flattenQuestionPaths,
	getCrossLevelMoveTargets,
	getQuestionMoveTargets,
} from "../questionNavigation";
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

describe("getQuestionMoveTargets", () => {
	const tree: Q[] = [
		{ id: "q1", type: "text" },
		{
			id: "grp",
			type: "group",
			children: [
				{ id: "child1", type: "text" },
				{ id: "child2", type: "int" },
				{ id: "child3", type: "text" },
			],
		},
		{ id: "q2", type: "text" },
		{ id: "q3", type: "date" },
	];

	it("returns siblings for root-level questions", () => {
		expect(getQuestionMoveTargets(tree, qpath("q2"))).toEqual({
			beforePath: qpath("grp"),
			afterPath: qpath("q3"),
		});
	});

	it("returns undefined beforePath for first root question", () => {
		expect(getQuestionMoveTargets(tree, qpath("q1"))).toEqual({
			beforePath: undefined,
			afterPath: qpath("grp"),
		});
	});

	it("returns undefined afterPath for last root question", () => {
		expect(getQuestionMoveTargets(tree, qpath("q3"))).toEqual({
			beforePath: qpath("q2"),
			afterPath: undefined,
		});
	});

	it("returns siblings within a group — not depth-first neighbors", () => {
		const childPath = qpath("child1", qpath("grp"));
		expect(getQuestionMoveTargets(tree, childPath)).toEqual({
			beforePath: undefined,
			afterPath: qpath("child2", qpath("grp")),
		});
	});

	it("returns undefined beforePath for first child in group", () => {
		const childPath = qpath("child1", qpath("grp"));
		const { beforePath } = getQuestionMoveTargets(tree, childPath);
		expect(beforePath).toBeUndefined();
	});

	it("returns undefined afterPath for last child in group", () => {
		const childPath = qpath("child3", qpath("grp"));
		const { afterPath } = getQuestionMoveTargets(tree, childPath);
		expect(afterPath).toBeUndefined();
	});

	it("returns correct middle-child targets inside a group", () => {
		const childPath = qpath("child2", qpath("grp"));
		expect(getQuestionMoveTargets(tree, childPath)).toEqual({
			beforePath: qpath("child1", qpath("grp")),
			afterPath: qpath("child3", qpath("grp")),
		});
	});

	it("includes hidden questions as valid siblings", () => {
		const withHidden: Q[] = [
			{ id: "q1", type: "text" },
			{ id: "h1", type: "hidden" },
			{ id: "q2", type: "text" },
		];
		expect(getQuestionMoveTargets(withHidden, qpath("q2"))).toEqual({
			beforePath: qpath("h1"),
			afterPath: undefined,
		});
	});

	it("handles nested groups", () => {
		const nested: Q[] = [
			{
				id: "outer",
				type: "group",
				children: [
					{
						id: "inner",
						type: "repeat",
						children: [
							{ id: "a", type: "text" },
							{ id: "b", type: "text" },
						],
					},
				],
			},
		];
		const deepPath = qpath("a", qpath("inner", qpath("outer")));
		expect(getQuestionMoveTargets(nested, deepPath)).toEqual({
			beforePath: undefined,
			afterPath: qpath("b", qpath("inner", qpath("outer"))),
		});
	});

	it("returns both undefined for unknown path", () => {
		expect(getQuestionMoveTargets(tree, qpath("nonexistent"))).toEqual({
			beforePath: undefined,
			afterPath: undefined,
		});
	});
});

describe("getCrossLevelMoveTargets", () => {
	const tree: Q[] = [
		{ id: "q1", type: "text" },
		{
			id: "grp",
			type: "group",
			children: [
				{ id: "child1", type: "text" },
				{ id: "child2", type: "int" },
				{ id: "child3", type: "text" },
			],
		},
		{ id: "q2", type: "text" },
		{ id: "q3", type: "date" },
	];

	/* ── Outdent: first/last child in group ── */

	it("outdent up: first child in group → before the group in parent", () => {
		const path = qpath("child1", qpath("grp"));
		const { up } = getCrossLevelMoveTargets(tree, path);
		expect(up).toEqual({
			targetParentPath: undefined, // form root
			beforePath: qpath("grp"),
			direction: "out",
		});
	});

	it("outdent down: last child in group → after the group in parent", () => {
		const path = qpath("child3", qpath("grp"));
		const { down } = getCrossLevelMoveTargets(tree, path);
		expect(down).toEqual({
			targetParentPath: undefined, // form root
			afterPath: qpath("grp"),
			direction: "out",
		});
	});

	/* ── Indent: adjacent sibling is a group ── */

	it("indent up: previous sibling is a group → move into it as last child", () => {
		const { up } = getCrossLevelMoveTargets(tree, qpath("q2"));
		expect(up).toEqual({
			targetParentPath: qpath("grp"),
			direction: "into",
		});
	});

	it("indent down: next sibling is a group → move into it as first child", () => {
		const { down } = getCrossLevelMoveTargets(tree, qpath("q1"));
		expect(down).toEqual({
			targetParentPath: qpath("grp"),
			beforePath: qpath("child1", qpath("grp")),
			direction: "into",
		});
	});

	it("indent down into empty group → no beforePath", () => {
		const withEmpty: Q[] = [
			{ id: "q1", type: "text" },
			{ id: "grp", type: "group", children: [] },
		];
		const { down } = getCrossLevelMoveTargets(withEmpty, qpath("q1"));
		expect(down).toEqual({
			targetParentPath: qpath("grp"),
			direction: "into",
		});
	});

	/* ── No cross-level move available ── */

	it("returns undefined for root-level question with no adjacent groups", () => {
		const { up, down } = getCrossLevelMoveTargets(tree, qpath("q3"));
		expect(up).toBeUndefined();
		expect(down).toBeUndefined();
	});

	it("returns undefined for middle child in group (no boundary)", () => {
		const path = qpath("child2", qpath("grp"));
		const { up, down } = getCrossLevelMoveTargets(tree, path);
		expect(up).toBeUndefined();
		expect(down).toBeUndefined();
	});

	/* ── Nested groups ── */

	it("outdent from nested group → into the outer group", () => {
		const nested: Q[] = [
			{
				id: "outer",
				type: "group",
				children: [
					{ id: "before", type: "text" },
					{
						id: "inner",
						type: "repeat",
						children: [{ id: "deep", type: "text" }],
					},
				],
			},
		];
		const deepPath = qpath("deep", qpath("inner", qpath("outer")));
		const { up } = getCrossLevelMoveTargets(nested, deepPath);
		expect(up).toEqual({
			targetParentPath: qpath("outer"),
			beforePath: qpath("inner", qpath("outer")),
			direction: "out",
		});
	});

	/* ── Repeat containers behave like groups ── */

	it("indent into an adjacent repeat", () => {
		const withRepeat: Q[] = [
			{ id: "q1", type: "text" },
			{
				id: "rep",
				type: "repeat",
				children: [{ id: "r1", type: "text" }],
			},
		];
		const { down } = getCrossLevelMoveTargets(withRepeat, qpath("q1"));
		expect(down).toEqual({
			targetParentPath: qpath("rep"),
			beforePath: qpath("r1", qpath("rep")),
			direction: "into",
		});
	});
});
