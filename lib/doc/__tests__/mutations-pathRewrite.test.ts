import { describe, expect, it } from "vitest";
import { rewriteXPathOnMove } from "@/lib/doc/mutations/pathRewrite";

describe("rewriteXPathOnMove", () => {
	it("rewrites absolute path when segments change", () => {
		const r = rewriteXPathOnMove(
			"/data/grp1/source",
			["grp1", "source"],
			["grp2", "source"],
		);
		expect(r.expr).toBe("/data/grp2/source");
		expect(r.droppedHashtagRefs).toBe(0);
	});

	it("rewrites deep-level path swaps", () => {
		expect(
			rewriteXPathOnMove("/data/a/b/c", ["a", "b", "c"], ["x", "y", "c"]).expr,
		).toBe("/data/x/y/c");
	});

	it("rewrites inside arithmetic expressions", () => {
		expect(
			rewriteXPathOnMove(
				"/data/grp1/source + 1",
				["grp1", "source"],
				["grp2", "source"],
			).expr,
		).toBe("/data/grp2/source + 1");
	});

	it("does not rewrite non-matching paths", () => {
		expect(
			rewriteXPathOnMove(
				"/data/other/field",
				["grp1", "source"],
				["grp2", "source"],
			).expr,
		).toBe("/data/other/field");
	});

	it("returns input unchanged for empty expression", () => {
		const r = rewriteXPathOnMove("", ["a"], ["b"]);
		expect(r.expr).toBe("");
		expect(r.droppedHashtagRefs).toBe(0);
	});

	it("rewrites top-level hashtag ref when both paths are top-level", () => {
		const r = rewriteXPathOnMove("#form/source", ["source"], ["renamed"]);
		expect(r.expr).toBe("#form/renamed");
		expect(r.droppedHashtagRefs).toBe(0);
	});

	it("counts hashtag as dropped when old path was nested", () => {
		// Hashtag `#form/source` matches the moved field's old id, but the
		// rewrite is cross-depth (nested → nested, both > 1) so the syntax
		// can't represent either. Ref is dropped and counted.
		const r = rewriteXPathOnMove(
			"#form/source",
			["grp1", "source"],
			["grp2", "source"],
		);
		expect(r.expr).toBe("#form/source");
		expect(r.droppedHashtagRefs).toBe(1);
	});

	it("counts hashtag as dropped when moving nested → top-level", () => {
		// Old path was nested (hashtag couldn't have pointed there), but the
		// ref uses the old leaf id. We still count matches conservatively —
		// the ref won't resolve correctly after the move either way.
		const r = rewriteXPathOnMove("#form/source", ["grp", "source"], ["source"]);
		expect(r.droppedHashtagRefs).toBe(1);
	});

	it("counts hashtag as dropped when moving top-level → nested", () => {
		const r = rewriteXPathOnMove("#form/source", ["source"], ["grp", "source"]);
		expect(r.droppedHashtagRefs).toBe(1);
	});

	it("rewrites when depth increases (top-level → nested) — absolute path only", () => {
		const r = rewriteXPathOnMove("/data/source", ["source"], ["grp", "source"]);
		expect(r.expr).toBe("/data/grp/source");
		expect(r.droppedHashtagRefs).toBe(0);
	});

	it("rewrites when depth decreases (nested → top-level) — absolute path only", () => {
		const r = rewriteXPathOnMove(
			"/data/grp/source",
			["grp", "source"],
			["source"],
		);
		expect(r.expr).toBe("/data/source");
		expect(r.droppedHashtagRefs).toBe(0);
	});

	it("counts multiple dropped hashtag refs in the same expression", () => {
		const r = rewriteXPathOnMove(
			"#form/source + #form/source",
			["grp", "source"],
			["other", "source"],
		);
		expect(r.droppedHashtagRefs).toBe(2);
	});
});
