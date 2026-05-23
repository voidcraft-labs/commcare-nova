// State-model coverage for the CustomDatePatternInput primitive's
// pure decisions: preset-vs-custom mode toggle and the empty-pattern
// gate. The primitive's UI is a deterministic projection of these
// outputs.

import { describe, expect, it } from "vitest";
import {
	type DatePatternPreset,
	isPresetPattern,
	validateCustomDatePattern,
} from "@/components/builder/shared/primitives/CustomDatePatternInput";

const PRESETS: readonly DatePatternPreset[] = [
	{ id: "short", label: "Short", pattern: "short" },
	{ id: "long", label: "Long", pattern: "long" },
	{ id: "iso", label: "ISO", pattern: "%Y-%m-%d" },
];

describe("isPresetPattern", () => {
	it("returns true when the value exactly matches a preset pattern", () => {
		expect(isPresetPattern("short", PRESETS)).toBe(true);
		expect(isPresetPattern("long", PRESETS)).toBe(true);
		expect(isPresetPattern("%Y-%m-%d", PRESETS)).toBe(true);
	});

	it("returns false when the value matches no preset", () => {
		expect(isPresetPattern("%d-%b-%Y", PRESETS)).toBe(false);
		expect(isPresetPattern("", PRESETS)).toBe(false);
	});

	it("returns false against an empty preset list", () => {
		expect(isPresetPattern("anything", [])).toBe(false);
	});
});

describe("validateCustomDatePattern", () => {
	it("returns ok for a non-empty draft", () => {
		expect(validateCustomDatePattern("%Y-%m-%d")).toEqual({ kind: "ok" });
	});

	it("returns empty for an empty-string draft", () => {
		// Schema's `z.string().min(1)` rejection surfaced earlier — the
		// primitive refuses the commit before the save-time parse.
		expect(validateCustomDatePattern("")).toEqual({ kind: "empty" });
	});

	it("returns empty for a whitespace-only draft (treated as empty)", () => {
		expect(validateCustomDatePattern("   ")).toEqual({ kind: "empty" });
		expect(validateCustomDatePattern("\t")).toEqual({ kind: "empty" });
		expect(validateCustomDatePattern("\n\t  ")).toEqual({ kind: "empty" });
	});

	it("returns ok for a draft with leading/trailing whitespace AND non-whitespace content", () => {
		// `trim() === ""` is the empty check, not `value === value.trim()`.
		// A draft like "  %Y-%m-%d  " is not "empty"; the primitive emits
		// the verbatim value (no auto-trim) so the consumer sees what
		// the user typed.
		expect(validateCustomDatePattern("  %Y-%m-%d  ")).toEqual({ kind: "ok" });
	});
});
