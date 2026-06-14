import { describe, expect, it } from "vitest";
import { expandHashtags, resolveFlatHashtag } from "@/lib/commcare/hashtags";
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

	it("rewrites top-level hashtag ref on a top-level → top-level move", () => {
		expect(rewriteXPathOnMove("#form/source", ["source"], ["renamed"])).toBe(
			"#form/renamed",
		);
	});

	it("re-anchors a hashtag ref on a top-level → nested move", () => {
		expect(
			rewriteXPathOnMove("#form/source", ["source"], ["grp", "source"]),
		).toBe("#form/grp/source");
	});

	it("re-anchors a hashtag ref on a nested → top-level move", () => {
		expect(
			rewriteXPathOnMove("#form/grp/source", ["grp", "source"], ["source"]),
		).toBe("#form/source");
	});

	it("re-anchors a hashtag ref on a nested → nested move", () => {
		expect(
			rewriteXPathOnMove(
				"#form/grp1/source",
				["grp1", "source"],
				["grp2", "source"],
			),
		).toBe("#form/grp2/source");
	});

	it("does not rewrite a hashtag whose full path differs from the moved field's", () => {
		// `#form/source` names a TOP-LEVEL field; the moved field lived at
		// `grp/source`. Same leaf, different path — never the moved field.
		expect(
			rewriteXPathOnMove(
				"#form/source",
				["grp", "source"],
				["other", "source"],
			),
		).toBe("#form/source");
	});

	it("re-anchors multiple hashtag refs in the same expression", () => {
		expect(
			rewriteXPathOnMove(
				"#form/source + #form/source",
				["source"],
				["grp", "source"],
			),
		).toBe("#form/grp/source + #form/grp/source");
	});

	it("rewrites when depth increases (top-level → nested) — absolute path", () => {
		expect(
			rewriteXPathOnMove("/data/source", ["source"], ["grp", "source"]),
		).toBe("/data/grp/source");
	});

	it("rewrites when depth decreases (nested → top-level) — absolute path", () => {
		expect(
			rewriteXPathOnMove("/data/grp/source", ["grp", "source"], ["source"]),
		).toBe("/data/source");
	});
});

describe("re-anchored hashtag → wire round-trip", () => {
	it("a re-anchored multi-segment ref expands to the moved field's /data path", () => {
		// Move `source` into `grp`: the ref re-anchors, then the wire
		// emitter's flat expansion produces the field's NEW absolute path.
		const reAnchored = rewriteXPathOnMove(
			"#form/source + 1",
			["source"],
			["grp", "source"],
		);
		expect(reAnchored).toBe("#form/grp/source + 1");
		expect(expandHashtags(reAnchored)).toBe("/data/grp/source + 1");
		expect(resolveFlatHashtag("form", ["grp", "source"])).toBe(
			"/data/grp/source",
		);
	});

	it("the reverse re-anchor expands back to the top-level path", () => {
		const reAnchored = rewriteXPathOnMove(
			"#form/grp/source",
			["grp", "source"],
			["source"],
		);
		expect(reAnchored).toBe("#form/source");
		expect(expandHashtags(reAnchored)).toBe("/data/source");
	});
});

describe("moved-CONTAINER descendant refs (prefix re-anchor)", () => {
	it("re-anchors a hashtag ref to a moved group's descendant (indent)", () => {
		expect(
			rewriteXPathOnMove("#form/grp/child = 1", ["grp"], ["outer", "grp"]),
		).toBe("#form/outer/grp/child = 1");
	});

	it("re-anchors a hashtag ref to a moved group's descendant (outdent)", () => {
		expect(
			rewriteXPathOnMove("#form/outer/grp/child", ["outer", "grp"], ["grp"]),
		).toBe("#form/grp/child");
	});

	it("re-anchors deep descendants, keeping the tail", () => {
		expect(
			rewriteXPathOnMove("#form/grp/sub/leaf", ["grp"], ["outer", "grp"]),
		).toBe("#form/outer/grp/sub/leaf");
	});

	it("hashtag and absolute spellings of the same dependency move together", () => {
		expect(
			rewriteXPathOnMove(
				"#form/grp/child = '1' and /data/grp/child != ''",
				["grp"],
				["outer", "grp"],
			),
		).toBe("#form/outer/grp/child = '1' and /data/outer/grp/child != ''");
	});

	it("never re-anchors a same-leaf ref that is not under the moved container", () => {
		// `other/grp/child` shares the `grp/child` tail but is anchored under
		// a different top-level container — prefix matching starts at
		// segment 0, so it is never the moved subtree.
		expect(
			rewriteXPathOnMove("#form/other/grp/child", ["grp"], ["outer", "grp"]),
		).toBe("#form/other/grp/child");
		// A leaf ref shorter than the moved path is never a descendant.
		expect(rewriteXPathOnMove("#form/child", ["grp", "child"], ["child"])).toBe(
			"#form/child",
		);
	});
});
