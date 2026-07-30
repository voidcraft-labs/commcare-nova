import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
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
		const needle = testUuid("needle");
		const predicate = eq(
			prop("client", "case_name"),
			ifExpr(
				whenInput(
					input(needle),
					eq(prop("client", "external_id"), input(needle)),
				),
				term(input(needle)),
				term(literal("fallback")),
			),
		);
		const found: Array<{ uuid: string; path: readonly (string | number)[] }> =
			[];

		walkInputRefsWithPaths(predicate, (ref, path) => {
			found.push({ uuid: ref.searchInputUuid, path });
		});

		expect(found).toEqual([
			{
				uuid: needle,
				path: ["right", "if", "cond", "when-input-present", "input"],
			},
			{
				uuid: needle,
				path: ["right", "if", "cond", "when-input-present", "clause", "right"],
			},
			{ uuid: needle, path: ["right", "if", "then"] },
		]);
	});

	it("threads paths from an expression through count.where and concat", () => {
		const needle = testUuid("needle");
		const expression = count(
			selfPath(),
			eq(
				prop("client", "case_name"),
				concat(term(literal("prefix")), term(input(needle))),
			),
		);
		const found: Array<{ uuid: string; path: readonly (string | number)[] }> =
			[];

		walkExpressionInputRefsWithPaths(expression, (ref, path) => {
			found.push({ uuid: ref.searchInputUuid, path });
		});

		expect(found).toEqual([
			{
				uuid: needle,
				path: ["count", "where", "right", "parts", 1],
			},
		]);
	});
});
