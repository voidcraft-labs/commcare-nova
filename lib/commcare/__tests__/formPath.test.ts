/**
 * Unit battery for `FormPath` — the typed-path foundation the wire-emission
 * pipeline lays over its string-template path construction. Every other
 * test in `lib/commcare/__tests__/` exercises `FormPath` indirectly through
 * compiled XForm / suite output; the contract tests here lock the type's
 * own invariants so a regression surfaces here first, not at the byte-diff
 * level several layers down.
 *
 * What the tests pin:
 *   - The root anchor and the parser produce structurally-equal paths for
 *     every shape `toXPath()` emits (parse / serialize round-trip).
 *   - Segment-name validation rejects illegal XML element names at the
 *     `child` / `attr` boundary — the rule the wire emitter relies on.
 *   - Attribute steps are terminal: `child` and `attr` both throw once
 *     the path ends in an attribute. The DOM-walker analog of "you can't
 *     descend into an attribute."
 *   - `toXPath()` and `toVellum()` agree on segment order; `toVellum()`
 *     substitutes `#form` for `/data` (the Vellum dual-attribute pattern
 *     in `lib/commcare/CLAUDE.md`).
 *   - `queryBoundIteration()` is structurally `.child("item")` — but the
 *     name is the audit trail for the model-iteration rewrite Vellum's
 *     `modelRepeatMugOptions.getPathName` performs.
 */

import { describe, expect, it } from "vitest";
import { FormPath } from "@/lib/commcare/xform/formPath";

describe("FormPath.root + toXPath", () => {
	it("serializes the root to /data", () => {
		expect(FormPath.root().toXPath()).toBe("/data");
	});

	it("serializes one element step", () => {
		expect(FormPath.root().child("name").toXPath()).toBe("/data/name");
	});

	it("serializes nested element steps", () => {
		expect(FormPath.root().child("children").child("subcase_0").toXPath()).toBe(
			"/data/children/subcase_0",
		);
	});

	it("serializes a terminating attribute step", () => {
		expect(FormPath.root().child("case").attr("case_id").toXPath()).toBe(
			"/data/case/@case_id",
		);
	});

	it("serializes a deep path with a terminating attribute", () => {
		expect(
			FormPath.root()
				.child("children")
				.child("subcase_0")
				.child("case")
				.attr("date_modified")
				.toXPath(),
		).toBe("/data/children/subcase_0/case/@date_modified");
	});
});

describe("FormPath.toVellum", () => {
	it("substitutes #form for the /data root", () => {
		expect(FormPath.root().toVellum()).toBe("#form");
	});

	it("preserves element + attribute steps verbatim", () => {
		expect(FormPath.root().child("case").attr("case_id").toVellum()).toBe(
			"#form/case/@case_id",
		);
	});
});

describe("FormPath.parse — round-trip with toXPath", () => {
	const samples: ReadonlyArray<string> = [
		"/data",
		"/data/name",
		"/data/children",
		"/data/children/subcase_0",
		"/data/children/subcase_0/case",
		"/data/children/subcase_0/case/@case_id",
		"/data/case/@user_id",
		"/data/children/item/child_name",
		"/data/children/item/subcase_1/case/index/parent",
	];

	for (const raw of samples) {
		it(`round-trips "${raw}"`, () => {
			expect(FormPath.parse(raw).toXPath()).toBe(raw);
		});
	}

	it("rejects a path that doesn't start at /data", () => {
		expect(() => FormPath.parse("/foo/bar")).toThrow(/anchored at \/data/);
	});

	it("rejects a path with an empty segment (double slash)", () => {
		expect(() => FormPath.parse("/data//x")).toThrow(/empty segment/);
	});

	it("rejects a path with a trailing slash", () => {
		expect(() => FormPath.parse("/data/x/")).toThrow(/empty segment/);
	});

	it("rejects an element name that isn't a valid XML name", () => {
		expect(() => FormPath.parse("/data/9bad")).toThrow(/invalid element/);
	});

	it("rejects an attribute name that isn't a valid XML name", () => {
		expect(() => FormPath.parse("/data/case/@9bad")).toThrow(
			/invalid attribute/,
		);
	});

	it("rejects a step after an attribute", () => {
		expect(() => FormPath.parse("/data/case/@case_id/foo")).toThrow(
			/step after an attribute/,
		);
	});
});

describe("FormPath.child / attr — segment-name validation", () => {
	it("accepts valid element names", () => {
		expect(() => FormPath.root().child("case_name")).not.toThrow();
		expect(() => FormPath.root().child("_underscore_first")).not.toThrow();
		expect(() => FormPath.root().child("name123")).not.toThrow();
	});

	it("rejects element names starting with a digit", () => {
		expect(() => FormPath.root().child("1bad")).toThrow(/invalid element/);
	});

	it("rejects element names containing a hyphen", () => {
		expect(() => FormPath.root().child("with-hyphen")).toThrow(
			/invalid element/,
		);
	});

	it("rejects element names containing a slash", () => {
		expect(() => FormPath.root().child("with/slash")).toThrow(
			/invalid element/,
		);
	});

	it("rejects an empty element name", () => {
		expect(() => FormPath.root().child("")).toThrow(/invalid element/);
	});

	it("rejects an invalid attribute name", () => {
		expect(() => FormPath.root().child("case").attr("1bad")).toThrow(
			/invalid attribute/,
		);
	});
});

describe("FormPath — attribute terminality", () => {
	it("throws when calling child after attr", () => {
		const terminal = FormPath.root().child("case").attr("case_id");
		expect(() => terminal.child("oops")).toThrow(/can't extend/);
	});

	it("throws when calling attr after attr", () => {
		const terminal = FormPath.root().child("case").attr("case_id");
		expect(() => terminal.attr("oops")).toThrow(/can't extend/);
	});

	it("endsInAttribute reflects the last segment", () => {
		expect(FormPath.root().endsInAttribute()).toBe(false);
		expect(FormPath.root().child("case").endsInAttribute()).toBe(false);
		expect(
			FormPath.root().child("case").attr("case_id").endsInAttribute(),
		).toBe(true);
	});
});

describe("FormPath.queryBoundIteration", () => {
	it("is structurally equivalent to .child('item')", () => {
		const explicit = FormPath.root().child("children").child("item");
		const named = FormPath.root().child("children").queryBoundIteration();
		expect(named.equals(explicit)).toBe(true);
		expect(named.toXPath()).toBe("/data/children/item");
	});

	it("composes with subsequent steps for child paths inside a query_bound repeat", () => {
		expect(
			FormPath.root()
				.child("children")
				.queryBoundIteration()
				.child("child_name")
				.toXPath(),
		).toBe("/data/children/item/child_name");
	});

	it("composes for query_bound subcase splice paths", () => {
		expect(
			FormPath.root()
				.child("children")
				.queryBoundIteration()
				.child("subcase_0")
				.child("case")
				.attr("case_id")
				.toXPath(),
		).toBe("/data/children/item/subcase_0/case/@case_id");
	});
});

describe("FormPath.parent", () => {
	it("drops the last segment", () => {
		const leaf = FormPath.root().child("case").attr("case_id");
		expect(leaf.parent().toXPath()).toBe("/data/case");
		expect(leaf.parent().parent().toXPath()).toBe("/data");
	});

	it("throws at the root", () => {
		expect(() => FormPath.root().parent()).toThrow(/no parent/);
	});
});

describe("FormPath.equals", () => {
	it("matches structurally-identical paths regardless of construction", () => {
		const a = FormPath.root().child("children").child("subcase_0");
		const b = FormPath.parse("/data/children/subcase_0");
		expect(a.equals(b)).toBe(true);
	});

	it("distinguishes element from attribute step at the same name", () => {
		// Synthetic — `attr` on something the parser would reject; build via parse
		// to bypass element-name vs attribute-name parity.
		const elt = FormPath.parse("/data/case_id");
		const att = FormPath.parse("/data/@case_id");
		expect(elt.equals(att)).toBe(false);
	});

	it("distinguishes paths that differ by trailing segment", () => {
		const shorter = FormPath.root().child("case");
		const longer = FormPath.root().child("case").attr("case_id");
		expect(shorter.equals(longer)).toBe(false);
	});

	it("returns true for two roots", () => {
		expect(FormPath.root().equals(FormPath.root())).toBe(true);
	});
});

describe("FormPath.segments — walker contract", () => {
	it("exposes segments in walk order with the root first", () => {
		const path = FormPath.root().child("children").child("subcase_0");
		const segs = path.segments();
		expect(segs.length).toBe(3);
		expect(segs[0]).toEqual({ kind: "element", name: "data" });
		expect(segs[1]).toEqual({ kind: "element", name: "children" });
		expect(segs[2]).toEqual({ kind: "element", name: "subcase_0" });
	});

	it("flags an attribute step in the segments list", () => {
		const path = FormPath.root().child("case").attr("case_id");
		const segs = path.segments();
		expect(segs[segs.length - 1]).toEqual({
			kind: "attribute",
			name: "case_id",
		});
	});
});
