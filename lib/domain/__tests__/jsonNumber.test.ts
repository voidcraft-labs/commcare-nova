import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	isPersistableJsonNumber,
	persistableJsonIntegerSchema,
	persistableJsonNonnegativeIntegerSchema,
	persistableJsonNumberSchema,
	persistableJsonPositiveIntegerSchema,
	persistableJsonPositiveNumberSchema,
} from "../jsonNumber";

describe("persistable JSON numbers", () => {
	it.each([0, 0.1, 1.5, Number.MIN_VALUE, Number.MAX_SAFE_INTEGER])(
		"admits %s",
		(value) => {
			expect(isPersistableJsonNumber(value)).toBe(true);
			expect(persistableJsonNumberSchema.parse(value)).toBe(value);
		},
	);

	it.each([
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
		-0,
		Number.MAX_SAFE_INTEGER + 1,
		Number.MIN_SAFE_INTEGER - 1,
	])("rejects %s before persistence", (value) => {
		expect(isPersistableJsonNumber(value)).toBe(false);
		expect(persistableJsonNumberSchema.safeParse(value).success).toBe(false);
	});

	it("preserves each slot's independent range and integer constraints", () => {
		expect(persistableJsonIntegerSchema.safeParse(-1).success).toBe(true);
		expect(persistableJsonIntegerSchema.safeParse(-0).success).toBe(false);
		expect(persistableJsonNonnegativeIntegerSchema.safeParse(0).success).toBe(
			true,
		);
		expect(persistableJsonNonnegativeIntegerSchema.safeParse(-1).success).toBe(
			false,
		);
		expect(persistableJsonPositiveIntegerSchema.safeParse(1.5).success).toBe(
			false,
		);
		expect(persistableJsonPositiveNumberSchema.safeParse(0).success).toBe(
			false,
		);
		expect(persistableJsonPositiveNumberSchema.safeParse(0.1).success).toBe(
			true,
		);
	});

	it("owns every persisted Blueprint numeric slot", () => {
		const root = process.cwd();
		const modules = readFileSync(
			path.join(root, "lib/domain/modules.ts"),
			"utf8",
		);
		const forms = readFileSync(path.join(root, "lib/domain/forms.ts"), "utf8");
		const predicates = readFileSync(
			path.join(root, "lib/domain/predicate/types.ts"),
			"utf8",
		);
		const automations = readFileSync(
			path.join(root, "lib/domain/automations.ts"),
			"utf8",
		);
		for (const obsolete of [
			"priority: z.number().int().min(0)",
			"x: z.number().int().min(0)",
			"y: z.number().int().min(0)",
			"width: z.number().int().min(1)",
			"height: z.number().int().min(1)",
			"threshold: z.number().int().positive()",
		]) {
			expect(modules).not.toContain(obsolete);
		}
		expect(forms).not.toContain("time_estimate: z.number().int().positive()");
		expect(predicates).not.toContain(
			"value: z.union([z.string(), z.number(), z.boolean(), z.null()])",
		);
		expect(predicates).not.toContain("distance: z.number().positive()");
		expect(modules).toContain("persistableJsonNonnegativeIntegerSchema");
		expect(modules).toContain("persistableJsonPositiveIntegerSchema");
		expect(forms).toContain("persistableJsonPositiveIntegerSchema");
		expect(predicates).toContain("persistableJsonNumberSchema");
		expect(predicates).toContain("persistableJsonPositiveNumberSchema");
		expect(automations).not.toContain("z.number()");
		expect(automations).toContain("persistableJsonIntegerSchema");
	});
});
