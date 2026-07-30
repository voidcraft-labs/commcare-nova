import { describe, expect, it } from "vitest";
import { asUuid } from "@/lib/domain";
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
					input(asUuid("a30315bc-3b75-4e23-82d5-f4602032d5d0")),
					eq(
						prop("client", "external_id"),
						input(asUuid("a30315bc-3b75-4e23-82d5-f4602032d5d0")),
					),
				),
				term(input(asUuid("a30315bc-3b75-4e23-82d5-f4602032d5d0"))),
				term(literal("fallback")),
			),
		);
		const found: Array<{
			searchInputUuid: string;
			path: readonly (string | number)[];
		}> = [];

		walkInputRefsWithPaths(predicate, (ref, path) => {
			found.push({ searchInputUuid: ref.searchInputUuid, path });
		});

		expect(found).toEqual([
			{
				searchInputUuid: "a30315bc-3b75-4e23-82d5-f4602032d5d0",
				path: ["right", "if", "cond", "when-input-present", "input"],
			},
			{
				searchInputUuid: "a30315bc-3b75-4e23-82d5-f4602032d5d0",
				path: ["right", "if", "cond", "when-input-present", "clause", "right"],
			},
			{
				searchInputUuid: "a30315bc-3b75-4e23-82d5-f4602032d5d0",
				path: ["right", "if", "then"],
			},
		]);
	});

	it("threads paths from an expression through count.where and concat", () => {
		const expression = count(
			selfPath(),
			eq(
				prop("client", "case_name"),
				concat(
					term(literal("prefix")),
					term(input(asUuid("a30315bc-3b75-4e23-82d5-f4602032d5d0"))),
				),
			),
		);
		const found: Array<{
			searchInputUuid: string;
			path: readonly (string | number)[];
		}> = [];

		walkExpressionInputRefsWithPaths(expression, (ref, path) => {
			found.push({ searchInputUuid: ref.searchInputUuid, path });
		});

		expect(found).toEqual([
			{
				searchInputUuid: "a30315bc-3b75-4e23-82d5-f4602032d5d0",
				path: ["count", "where", "right", "parts", 1],
			},
		]);
	});
});
