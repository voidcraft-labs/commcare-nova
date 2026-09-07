/**
 * The hidden field's Value control is one control over two slots, and the
 * document may hold only one of them. These pin the mode the control shows
 * for every slot combination and the exact patch each gesture dispatches:
 * a patch that names only one slot is the defect, because it is how a field
 * would end up holding both.
 */

import { describe, expect, it } from "vitest";
import { xp } from "@/lib/__tests__/docHelpers";
import { HIDDEN_INERT_VALUE } from "@/lib/domain";
import {
	activeHiddenValueMode,
	hiddenValueModeHint,
	hiddenValueModeSwitchPatch,
	hiddenValueSavePatch,
	isInertHiddenValue,
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
	it("is keep in step when neither is stored", () => {
		expect(activeHiddenValueMode({})).toBe("calculate");
	});
});

describe("isInertHiddenValue", () => {
	it("recognizes the born placeholder", () => {
		expect(isInertHiddenValue(HIDDEN_INERT_VALUE)).toBe(true);
		expect(isInertHiddenValue(xp("''"))).toBe(true);
	});
	it("rejects a padded literal, a blank text run, a real value, and nothing", () => {
		expect(isInertHiddenValue(xp("' '"))).toBe(false);
		expect(isInertHiddenValue({ parts: [{ kind: "text", text: "" }] })).toBe(
			false,
		);
		expect(isInertHiddenValue(calc)).toBe(false);
		expect(isInertHiddenValue(undefined)).toBe(false);
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
	it("substitutes the inert placeholder for an empty save", () => {
		expect(hiddenValueSavePatch("calculate", undefined)).toEqual({
			calculate: HIDDEN_INERT_VALUE,
			default_value: null,
		});
		expect(hiddenValueSavePatch("default_value", undefined)).toEqual({
			default_value: HIDDEN_INERT_VALUE,
			calculate: null,
		});
	});
	it("saving on a historical both-present field clears the dead default", () => {
		const field = { calculate: calc, default_value: seed };
		const patch = hiddenValueSavePatch(activeHiddenValueMode(field), xp("2"));
		expect(patch).toEqual({ calculate: xp("2"), default_value: null });
	});
});

describe("hiddenValueModeSwitchPatch", () => {
	it("carries the expression into the new mode and clears the old slot", () => {
		expect(
			hiddenValueModeSwitchPatch({ calculate: calc }, "default_value"),
		).toEqual({ default_value: calc, calculate: null });
		expect(
			hiddenValueModeSwitchPatch({ default_value: seed }, "calculate"),
		).toEqual({ calculate: seed, default_value: null });
	});
	it("substitutes the inert placeholder when there is nothing to carry", () => {
		expect(hiddenValueModeSwitchPatch({}, "default_value")).toEqual({
			default_value: HIDDEN_INERT_VALUE,
			calculate: null,
		});
	});
	it("is null when the mode is already active", () => {
		expect(hiddenValueModeSwitchPatch({ calculate: calc }, "calculate")).toBe(
			null,
		);
		expect(
			hiddenValueModeSwitchPatch({ default_value: seed }, "default_value"),
		).toBe(null);
		expect(hiddenValueModeSwitchPatch({}, "calculate")).toBe(null);
	});
	it("switching a historical both-present field to set once carries the calculation and drops the default", () => {
		expect(
			hiddenValueModeSwitchPatch(
				{ calculate: calc, default_value: seed },
				"default_value",
			),
		).toEqual({ default_value: calc, calculate: null });
	});
});

describe("hiddenValueModeHint", () => {
	it("names the save-and-resume difference between the modes", () => {
		expect(hiddenValueModeHint("calculate", false)).toContain(
			"each time the form opens",
		);
		expect(hiddenValueModeHint("default_value", false)).toContain(
			"first opens",
		);
	});
	it("says what each mode means on a preloaded writer", () => {
		expect(hiddenValueModeHint("calculate", true)).toContain(
			"replaces this case's current value",
		);
		expect(hiddenValueModeHint("default_value", true)).toContain(
			"Opens with this case's current value",
		);
	});
});
