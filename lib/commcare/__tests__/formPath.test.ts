import { describe, expect, it } from "vitest";
import { FormPath } from "@/lib/commcare/xform/formPath";

describe("structural XForm paths", () => {
	it("branches immutable paths and exposes the exact walker and editor projections", () => {
		const root = FormPath.root();
		const children = root.child("children");
		const item = children.queryBoundIteration();
		const casePath = item.child("subcase_0").child("case");
		const attribute = casePath.attr("case_id");
		expect(root.toXPath()).toBe("/data");
		expect(root.toVellum()).toBe("#form");
		expect(children.toXPath()).toBe("/data/children");
		expect(item.child("child_name").toXPath()).toBe(
			"/data/children/item/child_name",
		);
		expect(attribute.toXPath()).toBe(
			"/data/children/item/subcase_0/case/@case_id",
		);
		expect(attribute.toVellum()).toBe(
			"#form/children/item/subcase_0/case/@case_id",
		);
		expect(attribute.segments()).toEqual([
			{ kind: "element", name: "data" },
			{ kind: "element", name: "children" },
			{ kind: "element", name: "item" },
			{ kind: "element", name: "subcase_0" },
			{ kind: "element", name: "case" },
			{ kind: "attribute", name: "case_id" },
		]);
		expect(attribute.parent().equals(casePath)).toBe(true);
		expect(children.parent().equals(root)).toBe(true);
		expect(() => root.parent()).toThrow(/no parent/);
	});

	it.each([
		["/data", "#form", [{ kind: "element", name: "data" }]],
		[
			"/data/_A2",
			"#form/_A2",
			[
				{ kind: "element", name: "data" },
				{ kind: "element", name: "_A2" },
			],
		],
		[
			"/data/case/@case_id",
			"#form/case/@case_id",
			[
				{ kind: "element", name: "data" },
				{ kind: "element", name: "case" },
				{ kind: "attribute", name: "case_id" },
			],
		],
	])(
		"parses %s into independently specified segments",
		(raw, editor, segments) => {
			const path = FormPath.parse(raw);
			expect(path.segments()).toEqual(segments);
			expect(path.toXPath()).toBe(raw);
			expect(path.toVellum()).toBe(editor);
		},
	);

	it.each([
		"",
		"data/x",
		"/foo/x",
		"/database/x",
		"/data/",
		"/data//x",
		"/data/x/",
		"/data/9bad",
		"/data/a-b",
		"/data/p:q",
		"/data/x[1]",
		"/data/case/@9bad",
		"/data/case/@id/child",
		"/data/name\n",
	])("refuses nonstructural or unsupported path %j", (raw) => {
		expect(() => FormPath.parse(raw)).toThrow(/FormPath.parse/);
	});

	it.each(["", "1bad", "with-hyphen", "with/slash", "p:q", "name\n"])(
		"enforces the same supported segment names in both builders: %j",
		(name) => {
			const root = FormPath.root();
			expect(() => root.child(name)).toThrow(/invalid element name/);
			expect(() => root.attr(name)).toThrow(/invalid attribute name/);
			expect(root.toXPath()).toBe("/data");
		},
	);

	it("attributes terminate construction while their parent remains extendable", () => {
		const parent = FormPath.root().child("case");
		const terminal = parent.attr("case_id");
		expect(parent.endsInAttribute()).toBe(false);
		expect(terminal.endsInAttribute()).toBe(true);
		expect(() => terminal.child("oops")).toThrow(/can't extend/);
		expect(() => terminal.attr("oops")).toThrow(/can't extend/);
		expect(terminal.parent().child("name").toXPath()).toBe("/data/case/name");
		expect(terminal.toXPath()).toBe("/data/case/@case_id");
	});

	it("equality distinguishes names, lengths, and attribute versus element identity", () => {
		const path = FormPath.root().child("case").attr("case_id");
		for (const [other, equal] of [
			["/data/case/@case_id", true],
			["/data/Case/@case_id", false],
			["/data/case/case_id", false],
			["/data/case", false],
			["/data/case/@owner_id", false],
		] as const) {
			const parsed = FormPath.parse(other);
			expect(path.equals(parsed), other).toBe(equal);
			expect(parsed.equals(path), other).toBe(equal);
		}
	});
});
