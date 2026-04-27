// lib/domain/__tests__/fields.test.ts
import { describe, expect, it } from "vitest";
import { fieldKinds, fieldRegistry, fieldSchema, isContainer } from "../fields";
import { asUuid } from "../uuid";

describe("fieldSchema", () => {
	it("accepts a valid text field", () => {
		const f = fieldSchema.parse({
			kind: "text",
			uuid: asUuid("abc-123"),
			id: "age",
			label: "Age",
		});
		expect(f.kind).toBe("text");
	});

	it("rejects a text field missing kind", () => {
		expect(() =>
			fieldSchema.parse({ uuid: asUuid("abc"), id: "age", label: "Age" }),
		).toThrow();
	});

	it("rejects unknown kind", () => {
		expect(() =>
			fieldSchema.parse({
				kind: "likert_scale",
				uuid: asUuid("abc"),
				id: "x",
				label: "X",
			}),
		).toThrow();
	});

	it("rejects single_select with <2 options", () => {
		expect(() =>
			fieldSchema.parse({
				kind: "single_select",
				uuid: asUuid("abc"),
				id: "x",
				label: "X",
				options: [{ value: "a", label: "A" }],
			}),
		).toThrow();
	});

	it("accepts a valid single_select with options", () => {
		const f = fieldSchema.parse({
			kind: "single_select",
			uuid: asUuid("abc"),
			id: "x",
			label: "X",
			options: [
				{ value: "a", label: "A" },
				{ value: "b", label: "B" },
			],
		});
		expect(f.kind).toBe("single_select");
	});

	it("strips options off a group field (group has no options in schema)", () => {
		// Zod strips unknown keys by default on non-strict schemas — assert
		// that options is NOT present on the parsed result, NOT that the
		// parse threw.
		const f = fieldSchema.parse({
			kind: "group",
			uuid: asUuid("abc"),
			id: "g",
			label: "G",
			options: [{ value: "a", label: "A" }],
		});
		expect(f.kind).toBe("group");
		// @ts-expect-error — GroupField has no options property
		expect(f.options).toBeUndefined();
	});

	it("rejects a hidden field missing calculate (required)", () => {
		expect(() =>
			fieldSchema.parse({
				kind: "hidden",
				uuid: asUuid("abc"),
				id: "x",
			}),
		).toThrow();
	});

	it("accepts a group with absent label (transparent structural container)", () => {
		// Container kinds extend `containerFieldBase` (label optional) so
		// empty-label groups can express invisible structural folders —
		// matches CommCare's runtime behavior for unlabeled <group>.
		const f = fieldSchema.parse({
			kind: "group",
			uuid: asUuid("abc"),
			id: "structural_only",
		});
		expect(f.kind).toBe("group");
		expect((f as { label?: string }).label).toBeUndefined();
	});

	it("accepts a group with empty-string label", () => {
		const f = fieldSchema.parse({
			kind: "group",
			uuid: asUuid("abc"),
			id: "structural_only",
			label: "",
		});
		expect(f.kind).toBe("group");
		expect((f as { label?: string }).label).toBe("");
	});

	it("accepts a repeat with absent label", () => {
		// Same contract as group: container kinds allow empty/absent
		// labels via `containerFieldBase`. Repeat additionally requires
		// `repeat_mode` (the mode discriminator); user_controlled is the
		// no-extra-fields variant that pairs naturally with this test's
		// "minimal valid repeat" intent.
		const f = fieldSchema.parse({
			kind: "repeat",
			uuid: asUuid("abc"),
			id: "data_loop",
			repeat_mode: "user_controlled",
		});
		expect(f.kind).toBe("repeat");
		expect((f as { label?: string }).label).toBeUndefined();
	});

	it("rejects a text field missing label (input fields still require labels)", () => {
		// Regression check: opening up labels on container kinds must not
		// leak into input kinds. `text` extends `inputFieldBaseSchema` →
		// `fieldBaseSchema` where `label` stays required.
		expect(() =>
			fieldSchema.parse({
				kind: "text",
				uuid: asUuid("abc"),
				id: "name",
			}),
		).toThrow();
	});

	it("strips label off a hidden field (hidden fields have no label)", () => {
		// Hidden fields extend `structuralFieldBase`, NOT `fieldBaseSchema` —
		// CommCare hidden fields display nothing and carry no label. Zod's
		// default `strip` mode drops `label` if it sneaks in, so any wire-
		// format input that carries one gets cleaned at the parse boundary.
		const f = fieldSchema.parse({
			kind: "hidden",
			uuid: asUuid("abc"),
			id: "h",
			label: "should be stripped",
			calculate: "today()",
		});
		expect(f.kind).toBe("hidden");
		expect(f).not.toHaveProperty("label");
	});
});

describe("fieldRegistry", () => {
	it("has an entry for every kind in fieldKinds", () => {
		for (const kind of fieldKinds) {
			expect(fieldRegistry[kind]).toBeDefined();
			expect(fieldRegistry[kind].kind).toBe(kind);
		}
	});
});

describe("isContainer", () => {
	it("returns true for group and repeat", () => {
		const g = fieldSchema.parse({
			kind: "group",
			uuid: asUuid("abc"),
			id: "g",
			label: "G",
		});
		expect(isContainer(g)).toBe(true);

		const r = fieldSchema.parse({
			kind: "repeat",
			uuid: asUuid("abc"),
			id: "r",
			label: "R",
			repeat_mode: "user_controlled",
		});
		expect(isContainer(r)).toBe(true);
	});

	it("returns false for input kinds", () => {
		const t = fieldSchema.parse({
			kind: "text",
			uuid: asUuid("abc"),
			id: "t",
			label: "T",
		});
		expect(isContainer(t)).toBe(false);
	});
});
