// State-model coverage for the OptionsEditor adapter's
// `clampOptionsBelowMin` boundary. Single-select / multi-select field
// schemas declare `.min(2)` on `options`; the adapter clamps below-min
// drafts to `undefined` so the reducer treats them as a removal patch
// rather than persisting a list that fails the next write's schema
// re-validation.

import { describe, expect, it } from "vitest";
import { clampOptionsBelowMin } from "@/components/builder/editor/fields/OptionsEditor";
import { asUuid } from "@/lib/doc/types";
import type { SelectOption } from "@/lib/domain";
import { multiSelectFieldSchema } from "@/lib/domain/fields/multiSelect";
import { singleSelectFieldSchema } from "@/lib/domain/fields/singleSelect";

const RED: SelectOption = { value: "red", label: "Red" };
const BLUE: SelectOption = { value: "blue", label: "Blue" };
const GREEN: SelectOption = { value: "green", label: "Green" };

describe("clampOptionsBelowMin — collapse arm", () => {
	it("collapses an empty list to undefined", () => {
		expect(clampOptionsBelowMin([])).toBeUndefined();
	});

	it("collapses a single-option list to undefined", () => {
		expect(clampOptionsBelowMin([RED])).toBeUndefined();
	});
});

describe("clampOptionsBelowMin — pass-through arm", () => {
	it("passes through a two-option list verbatim", () => {
		expect(clampOptionsBelowMin([RED, BLUE])).toEqual([RED, BLUE]);
	});

	it("passes through longer lists verbatim", () => {
		expect(clampOptionsBelowMin([RED, BLUE, GREEN])).toEqual([
			RED,
			BLUE,
			GREEN,
		]);
	});
});

describe("clampOptionsBelowMin — matches the schema's enforcement boundary", () => {
	// The schema-level `.min(2)` is the canonical authority on the
	// allowed list length. The clamp's collapse-vs-pass-through threshold
	// must match that schema. Round-trip a clamped result through the
	// schema to confirm: pass-through arm parses cleanly, collapse arm
	// returns `undefined` (which the reducer routes as a remove).
	const baseField = {
		kind: "single_select" as const,
		uuid: asUuid("00000000-0000-0000-0000-000000000401"),
		id: "color",
		label: "Color",
	};

	it("clamped pass-through arm parses through singleSelectFieldSchema", () => {
		const clamped = clampOptionsBelowMin([RED, BLUE]);
		expect(clamped).toBeDefined();
		const parsed = singleSelectFieldSchema.safeParse({
			...baseField,
			options: clamped,
		});
		expect(parsed.success).toBe(true);
	});

	it("a non-clamped single-option list would fail the schema (clamp's reason for being)", () => {
		// Without the clamp, an `onSave([RED])` would land a single-option
		// list on the persisted doc; the next validation pass would
		// reject it. The clamp's existence prevents this.
		const parsed = singleSelectFieldSchema.safeParse({
			...baseField,
			options: [RED],
		});
		expect(parsed.success).toBe(false);
	});

	it("multi-select schema mirrors the single-select min(2) constraint", () => {
		// Same `.min(2)` applies to multi-select; the clamp covers both
		// kinds since the adapter is generic over the field type.
		const parsed = multiSelectFieldSchema.safeParse({
			...baseField,
			kind: "multi_select" as const,
			options: [RED],
		});
		expect(parsed.success).toBe(false);
	});
});
