import { describe, expect, it } from "vitest";
import { rewriteHashtagRefs, rewriteXPathRefs } from "../rewrite";

describe("rewriteXPathRefs", () => {
	describe("absolute paths", () => {
		it("rewrites a simple top-level reference", () => {
			expect(rewriteXPathRefs("/data/old_id > 5", "old_id", "new_id")).toBe(
				"/data/new_id > 5",
			);
		});

		it("rewrites a nested field reference", () => {
			expect(
				rewriteXPathRefs(
					'/data/group/old_id = "yes"',
					"group/old_id",
					"new_id",
				),
			).toBe('/data/group/new_id = "yes"');
		});

		it("rewrites multiple occurrences in one expression", () => {
			expect(
				rewriteXPathRefs(
					"/data/old_id > 0 and /data/old_id < 100",
					"old_id",
					"new_id",
				),
			).toBe("/data/new_id > 0 and /data/new_id < 100");
		});

		it("does not rewrite paths that do not match", () => {
			expect(rewriteXPathRefs("/data/other_id > 5", "old_id", "new_id")).toBe(
				"/data/other_id > 5",
			);
		});

		it("does not rewrite partial segment matches", () => {
			// /data/old_id_extra should NOT match oldPath 'old_id'
			expect(
				rewriteXPathRefs("/data/old_id_extra > 5", "old_id", "new_id"),
			).toBe("/data/old_id_extra > 5");
		});

		it("handles paths inside function calls", () => {
			expect(
				rewriteXPathRefs(
					'if(/data/old_id = "yes", "a", "b")',
					"old_id",
					"new_id",
				),
			).toBe('if(/data/new_id = "yes", "a", "b")');
		});

		it("handles predicates referencing the field", () => {
			expect(
				rewriteXPathRefs(
					"count(/data/repeat[/data/old_id > 0])",
					"old_id",
					"new_id",
				),
			).toBe("count(/data/repeat[/data/new_id > 0])");
		});
	});

	describe("hashtag refs", () => {
		it("rewrites #form/ hashtag for top-level questions", () => {
			expect(rewriteXPathRefs("#form/old_id > 5", "old_id", "new_id")).toBe(
				"#form/new_id > 5",
			);
		});

		it("does not rewrite #case/ or #user/ hashtags", () => {
			expect(rewriteXPathRefs("#case/old_id > 5", "old_id", "new_id")).toBe(
				"#case/old_id > 5",
			);
		});

		it("does not rewrite #form/ hashtag for nested questions", () => {
			// Nested questions use full paths, not #form/ shorthand
			expect(
				rewriteXPathRefs("#form/old_id > 5", "group/old_id", "new_id"),
			).toBe("#form/old_id > 5");
		});

		it("rewrites both hashtag and absolute path in one expression", () => {
			expect(
				rewriteXPathRefs(
					"#form/old_id > 0 and /data/old_id < 100",
					"old_id",
					"new_id",
				),
			).toBe("#form/new_id > 0 and /data/new_id < 100");
		});
	});

	describe("edge cases", () => {
		it("returns empty string unchanged", () => {
			expect(rewriteXPathRefs("", "old_id", "new_id")).toBe("");
		});

		it("returns expression with no matching refs unchanged", () => {
			expect(rewriteXPathRefs("1 + 2", "old_id", "new_id")).toBe("1 + 2");
		});

		it("handles string literals containing path-like text (no rewrite)", () => {
			expect(rewriteXPathRefs('"/data/old_id"', "old_id", "new_id")).toBe(
				'"/data/old_id"',
			);
		});
	});
});

describe("rewriteHashtagRefs", () => {
	it("rewrites #case/ refs", () => {
		expect(
			rewriteHashtagRefs(
				"#case/client_name",
				"#case/",
				"client_name",
				"full_name",
			),
		).toBe("#case/full_name");
	});

	it("rewrites multiple #case/ refs in one expression", () => {
		expect(
			rewriteHashtagRefs(
				'concat(#case/first_name, " ", #case/first_name)',
				"#case/",
				"first_name",
				"given_name",
			),
		).toBe('concat(#case/given_name, " ", #case/given_name)');
	});

	it("does not rewrite other hashtag prefixes", () => {
		expect(
			rewriteHashtagRefs(
				"#form/client_name > 0",
				"#case/",
				"client_name",
				"full_name",
			),
		).toBe("#form/client_name > 0");
	});

	it("does not rewrite partial name matches", () => {
		expect(
			rewriteHashtagRefs(
				"#case/client_name_full",
				"#case/",
				"client_name",
				"full_name",
			),
		).toBe("#case/client_name_full");
	});

	it("returns empty string unchanged", () => {
		expect(rewriteHashtagRefs("", "#case/", "old", "new")).toBe("");
	});
});
