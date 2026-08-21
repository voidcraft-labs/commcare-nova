import { describe, expect, it } from "vitest";
import {
	DEFAULT_SELECT_OPTIONS,
	isMintedSelectOptionPlaceholder,
	mintSelectOptionPlaceholder,
} from "../fields/base";
import { proseTemplateText, proseText } from "../prose";
import { isValidSelectOptionValue } from "../selectOptionValue";

describe("mintSelectOptionPlaceholder", () => {
	it("is the minter behind a fresh select's starter options", () => {
		expect(DEFAULT_SELECT_OPTIONS).toEqual([
			mintSelectOptionPlaceholder(1),
			mintSelectOptionPlaceholder(2),
		]);
		expect(mintSelectOptionPlaceholder(3).value).toBe("option_3");
		expect(proseTemplateText(mintSelectOptionPlaceholder(3).label)).toBe(
			"Option 3",
		);
	});

	it("mints a value inside the stored-value grammar", () => {
		for (const n of [1, 2, 12, 100]) {
			expect(
				isValidSelectOptionValue(mintSelectOptionPlaceholder(n).value),
			).toBe(true);
		}
	});
});

describe("isMintedSelectOptionPlaceholder", () => {
	it("recognizes exactly what the minter produced, at any position", () => {
		expect(
			isMintedSelectOptionPlaceholder(mintSelectOptionPlaceholder(1)),
		).toBe(true);
		expect(
			isMintedSelectOptionPlaceholder(mintSelectOptionPlaceholder(12)),
		).toBe(true);
		for (const option of DEFAULT_SELECT_OPTIONS) {
			expect(isMintedSelectOptionPlaceholder(option)).toBe(true);
		}
	});

	it("treats a hand-edited value or label as chosen", () => {
		expect(
			isMintedSelectOptionPlaceholder({
				value: "yes",
				label: proseText("Option 1"),
			}),
		).toBe(false);
		expect(
			isMintedSelectOptionPlaceholder({
				value: "option_1",
				label: proseText("Yes"),
			}),
		).toBe(false);
		// The number has to match: a renumbered row was not minted this way.
		expect(
			isMintedSelectOptionPlaceholder({
				value: "option_1",
				label: proseText("Option 2"),
			}),
		).toBe(false);
		// A zero-padded value is not something the minter writes.
		expect(
			isMintedSelectOptionPlaceholder({
				value: "option_01",
				label: proseText("Option 1"),
			}),
		).toBe(false);
	});
});
