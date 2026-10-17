/**
 * The hidden field's Value control is one control over two slots, and the
 * document may hold only one of them. These pin the mode the control shows
 * for every slot combination and the exact patch each gesture dispatches:
 * a patch that names only one slot is the defect, because it is how a field
 * would end up holding both. The other defect they pin is a calculation
 * no one typed reaching `calculate`: an empty save or a switch with nothing
 * to carry must leave the field holding neither slot.
 */

import { describe, expect, it } from "vitest";
import { xp } from "@/lib/__tests__/docHelpers";
import {
	activeHiddenValueMode,
	HIDDEN_VALUE_EMPTY_PATCH,
	hiddenValueModeHint,
	hiddenValueModeSwitch,
	hiddenValueSavePatch,
} from "../hiddenValueModel";

const calc = xp("1 + 1");
const seed = xp("'x'");

describe("activeHiddenValueMode", () => {
	it("is keep in step when only a calculation is stored", () => {
		expect(activeHiddenValueMode({ calculate: calc })).toBe("calculate");
	});
	it("is set once when only a default is stored", () => {
		expect(activeHiddenValueMode({ default_value: seed })).toBe(
			"default_value",
		);
	});
	it("is keep in step for a historical field holding both, since the calculation is what runs", () => {
		expect(
			activeHiddenValueMode({ calculate: calc, default_value: seed }),
		).toBe("calculate");
	});
	it("is set once when neither is stored", () => {
		expect(activeHiddenValueMode({})).toBe("default_value");
	});
});

describe("hiddenValueSavePatch", () => {
	it("writes the expression into the mode and clears the other slot", () => {
		expect(hiddenValueSavePatch("calculate", calc)).toEqual({
			calculate: calc,
			default_value: null,
		});
		expect(hiddenValueSavePatch("default_value", seed)).toEqual({
			default_value: seed,
			calculate: null,
		});
	});
	it("lands an empty save as neither slot in either mode", () => {
		expect(hiddenValueSavePatch("calculate", undefined)).toEqual(
			HIDDEN_VALUE_EMPTY_PATCH,
		);
		expect(hiddenValueSavePatch("default_value", undefined)).toEqual(
			HIDDEN_VALUE_EMPTY_PATCH,
		);
		expect(HIDDEN_VALUE_EMPTY_PATCH).toEqual({
			calculate: null,
			default_value: null,
		});
	});
	it("saving on a historical both-present field clears the dead default", () => {
		const field = { calculate: calc, default_value: seed };
		const patch = hiddenValueSavePatch(activeHiddenValueMode(field), xp("2"));
		expect(patch).toEqual({ calculate: xp("2"), default_value: null });
	});
});

describe("hiddenValueModeSwitch", () => {
	it("carries an authored expression into the new mode and clears the old slot", () => {
		expect(hiddenValueModeSwitch({ calculate: calc }, "default_value")).toEqual(
			{
				kind: "commit",
				patch: { default_value: calc, calculate: null },
			},
		);
		expect(hiddenValueModeSwitch({ default_value: seed }, "calculate")).toEqual(
			{
				kind: "commit",
				patch: { calculate: seed, default_value: null },
			},
		);
	});
	it("waits for a calculation toward keep in step when there is nothing to carry", () => {
		expect(hiddenValueModeSwitch({}, "calculate")).toEqual({
			kind: "await-calculation",
		});
	});
	it("is unchanged when the mode is already stored", () => {
		expect(hiddenValueModeSwitch({ calculate: calc }, "calculate")).toEqual({
			kind: "unchanged",
		});
		expect(
			hiddenValueModeSwitch({ default_value: seed }, "default_value"),
		).toEqual({ kind: "unchanged" });
		expect(hiddenValueModeSwitch({}, "default_value")).toEqual({
			kind: "unchanged",
		});
	});
	it("switching a historical both-present field to set once carries the calculation and drops the default", () => {
		expect(
			hiddenValueModeSwitch(
				{ calculate: calc, default_value: seed },
				"default_value",
			),
		).toEqual({
			kind: "commit",
			patch: { default_value: calc, calculate: null },
		});
	});
	it("never writes a calculation that was not authored", () => {
		const fields = [
			{},
			{ default_value: seed },
			{ calculate: calc },
			{ calculate: calc, default_value: seed },
		];
		for (const field of fields) {
			for (const next of ["calculate", "default_value"] as const) {
				const verdict = hiddenValueModeSwitch(field, next);
				if (verdict.kind === "commit" && verdict.patch.calculate !== null) {
					expect([calc, seed]).toContain(verdict.patch.calculate);
				}
			}
		}
		expect(hiddenValueSavePatch("calculate", undefined).calculate).toBeNull();
	});
});

describe("hiddenValueModeHint", () => {
	it("names the save-and-resume difference between the modes", () => {
		expect(hiddenValueModeHint("calculate", false, undefined, false)).toContain(
			"each time the form opens",
		);
		expect(
			hiddenValueModeHint("default_value", false, undefined, false),
		).toContain("first opens");
	});
	it("says what each mode means on a preloaded writer", () => {
		expect(hiddenValueModeHint("calculate", true, undefined, false)).toContain(
			"replaces this case's current value",
		);
		expect(
			hiddenValueModeHint("default_value", true, undefined, false),
		).toContain("Opens with this case's current value");
	});
	it("is the blank-write note at rest, in either mode", () => {
		const note =
			"Has no value yet, so each submission saves visit_count blank.";
		expect(hiddenValueModeHint("calculate", false, note, false)).toBe(note);
		expect(hiddenValueModeHint("default_value", false, note, false)).toBe(note);
	});
	it("says what the mode does while another value is being chosen", () => {
		const note =
			"Has no value yet, so each submission saves visit_count blank.";
		expect(hiddenValueModeHint("calculate", false, note, true)).toContain(
			"each time the form opens",
		);
		expect(hiddenValueModeHint("default_value", true, note, true)).toContain(
			"Opens with this case's current value",
		);
	});
});
