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

	it("rejects a group field that sets options (not in schema)", () => {
		// Zod strips unknown keys by default on non-strict schemas — assert
		// instead that options is NOT present on the parsed result.
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
