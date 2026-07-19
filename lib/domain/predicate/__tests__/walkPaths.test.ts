import { describe, expect, it } from "vitest";
import {
	concat,
	count,
	eq,
	ifExpr,
	input,
	literal,
	prop,
	selfPath,
	term,
	walkExpressionInputRefsWithPaths,
	walkInputRefsWithPaths,
	whenInput,
} from "@/lib/domain/predicate";

describe("Search-input reference paths", () => {
	it("threads paths through predicate, expression, and nested predicate families", () => {
		const predicate = eq(
			prop("client", "case_name"),
			ifExpr(
				whenInput(
					input("needle"),
					eq(prop("client", "external_id"), input("needle")),
				),
				term(input("needle")),
				term(literal("fallback")),
			),
		);
		const found: Array<{ name: string; path: readonly (string | number)[] }> =
			[];

		walkInputRefsWithPaths(predicate, (ref, path) => {
			found.push({ name: ref.name, path });
		});

		expect(found).toEqual([
			{
				name: "needle",
				path: ["right", "if", "cond", "when-input-present", "input"],
			},
			{
				name: "needle",
				path: ["right", "if", "cond", "when-input-present", "clause", "right"],
			},
			{ name: "needle", path: ["right", "if", "then"] },
		]);
	});

	it("threads paths from an expression through count.where and concat", () => {
		const expression = count(
			selfPath(),
			eq(
				prop("client", "case_name"),
				concat(term(literal("prefix")), term(input("needle"))),
			),
		);
		const found: Array<{ name: string; path: readonly (string | number)[] }> =
			[];

		walkExpressionInputRefsWithPaths(expression, (ref, path) => {
			found.push({ name: ref.name, path });
		});

		expect(found).toEqual([
			{
				name: "needle",
				path: ["count", "where", "right", "parts", 1],
			},
		]);
	});
});
