/**
 * The heading outline a reader navigates a system prompt by.
 *
 * The plausible failure is a section boundary in the wrong place: a `#`
 * inside a fenced example splitting a section, a `---` rule swallowed into
 * its neighbor, or a preamble lost because it has no heading. Each proof
 * asserts the boundary, the level, and the source line the jump link needs.
 */

import { describe, expect, it } from "vitest";
import { outlineText } from "../outline";

describe("outlineText", () => {
	it("returns no sections for empty or whitespace text", () => {
		expect(outlineText("")).toEqual([]);
		expect(outlineText("\n  \n")).toEqual([]);
	});

	it("opens a section per heading with its level, title, and line", () => {
		const text = [
			"# Top",
			"intro",
			"## Second",
			"body",
			"### Third ##",
			"more",
		].join("\n");
		const sections = outlineText(text);
		expect(
			sections.map(({ level, title, line }) => ({ level, title, line })),
		).toEqual([
			{ level: 1, title: "Top", line: 0 },
			{ level: 2, title: "Second", line: 2 },
			{ level: 3, title: "Third", line: 4 },
		]);
		expect(sections[0]?.text).toBe("# Top\nintro");
		expect(sections[2]?.text).toBe("### Third ##\nmore");
	});

	it("titles a heading-less preamble by its first non-blank line at level 0", () => {
		const sections = outlineText("\nYou are Nova.\nMore.\n## Later\nx");
		expect(sections[0]).toMatchObject({
			level: 0,
			title: "You are Nova.",
			line: 0,
		});
		expect(sections[0]?.text).toBe("\nYou are Nova.\nMore.");
		expect(sections[1]).toMatchObject({ level: 2, title: "Later", line: 3 });
	});

	it("opens a level-0 section at a horizontal rule outside a fence", () => {
		const sections = outlineText("first part\n\n---\n\nsecond part\n");
		expect(
			sections.map(({ level, title, line }) => ({ level, title, line })),
		).toEqual([
			{ level: 0, title: "first part", line: 0 },
			{ level: 0, title: "second part", line: 3 },
		]);
		expect(sections[1]?.text).not.toContain("---");
	});

	it("keeps headings and rules inside a backtick fence in one section", () => {
		const text = [
			"## Real",
			"```md",
			"# not a heading",
			"---",
			"## also not",
			"```",
			"after",
			"## Next",
		].join("\n");
		const sections = outlineText(text);
		expect(sections.map((section) => section.title)).toEqual(["Real", "Next"]);
		expect(sections[0]?.text).toContain("# not a heading");
		expect(sections[0]?.text).toContain("---");
		expect(sections[0]?.text).toContain("after");
	});

	it("closes a tilde fence only with a tilde fence", () => {
		const text = [
			"## Real",
			"~~~",
			"```",
			"# still inside",
			"```",
			"~~~",
			"## Next",
		].join("\n");
		expect(outlineText(text).map((section) => section.title)).toEqual([
			"Real",
			"Next",
		]);
	});

	it("gives every section a distinct id, even for repeated titles", () => {
		const sections = outlineText("## Same\na\n## Same\nb\n## Same\nc");
		const ids = sections.map((section) => section.id);
		expect(new Set(ids).size).toBe(3);
	});
});
