// State-model coverage for the optional-key dispatch gate. Pins the
// passive-interaction regression backstop: focusing then blurring an
// empty input on a slot that's already absent must not stamp an undo-
// history entry. The gate fires `true` only when there's a real value
// to clear.

import { describe, expect, it } from "vitest";
import { shouldDispatchClear } from "@/components/builder/editor/fields/TextEditor";

describe("shouldDispatchClear", () => {
	it("returns false for an undefined value (the slot is already absent)", () => {
		expect(shouldDispatchClear(undefined)).toBe(false);
	});

	it("returns true for a non-empty string", () => {
		expect(shouldDispatchClear("hint text")).toBe(true);
	});

	it("returns true for an empty string (the slot is present-with-empty)", () => {
		// Empty string is structurally distinct from `undefined`: a slot
		// with `""` exists but holds an empty value. The reducer's removal
		// patch still has to flip it from "" → absent. The gate fires.
		expect(shouldDispatchClear("")).toBe(true);
	});

	it("returns true for falsy non-undefined values (zero, null, false)", () => {
		// The gate's `!== undefined` predicate intentionally treats every
		// other value — including `null`, `0`, `false` — as "present, so
		// dispatch a clear if asked." Slot value types vary across field
		// kinds; only `undefined` carries the "absent" signal.
		expect(shouldDispatchClear(0)).toBe(true);
		expect(shouldDispatchClear(null)).toBe(true);
		expect(shouldDispatchClear(false)).toBe(true);
	});
});
