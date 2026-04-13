import { describe, expect, it } from "vitest";
import { rewriteXPathOnMove } from "@/lib/doc/mutations/pathRewrite";

describe("rewriteXPathOnMove", () => {
	it("rewrites absolute path when segments change", () => {
		expect(
			rewriteXPathOnMove(
				"/data/grp1/source",
				["grp1", "source"],
				["grp2", "source"],
			),
		).toBe("/data/grp2/source");
	});

	it("rewrites deep-level path swaps", () => {
		expect(
			rewriteXPathOnMove("/data/a/b/c", ["a", "b", "c"], ["x", "y", "c"]),
		).toBe("/data/x/y/c");
	});

	it("rewrites inside arithmetic expressions", () => {
		expect(
			rewriteXPathOnMove(
				"/data/grp1/source + 1",
				["grp1", "source"],
				["grp2", "source"],
			),
		).toBe("/data/grp2/source + 1");
	});

	it("does not rewrite non-matching paths", () => {
		expect(
			rewriteXPathOnMove(
				"/data/other/field",
				["grp1", "source"],
				["grp2", "source"],
			),
		).toBe("/data/other/field");
	});

	it("returns input unchanged for empty expression", () => {
		expect(rewriteXPathOnMove("", ["a"], ["b"])).toBe("");
	});

	it("rewrites top-level hashtag ref when both paths are top-level", () => {
		expect(rewriteXPathOnMove("#form/source", ["source"], ["renamed"])).toBe(
			"#form/renamed",
		);
	});

	it("does not rewrite hashtag when old path was nested", () => {
		expect(
			rewriteXPathOnMove(
				"#form/source",
				["grp1", "source"],
				["grp2", "source"],
			),
		).toBe("#form/source");
	});
});
