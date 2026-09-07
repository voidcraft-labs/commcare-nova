import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	DEFAULT_SELECT_OPTIONS,
	isMintedSelectOptionPlaceholder,
	mintSelectOptionPlaceholder,
} from "../fields/base";
import { proseTemplateSchema, proseTemplateText, proseText } from "../prose";
import { isValidSelectOptionValue } from "../selectOptionValue";

describe("mintSelectOptionPlaceholder", () => {
	it("is the minter behind a fresh select's starter options", () => {
		expect(DEFAULT_SELECT_OPTIONS).toEqual([
			{ value: "option_1", label: proseText("Option 1") },
			{ value: "option_2", label: proseText("Option 2") },
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
	it("recognizes generated placeholder labels across sampled positions", () => {
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

	it("treats a structural reference in the label as authored content", () => {
		const label = proseTemplateSchema.parse({
			parts: [
				{ kind: "text", text: "Option 1" },
				{ kind: "field-ref", uuid: testUuid("placeholder-label-field") },
			],
		});
		expect(isMintedSelectOptionPlaceholder({ value: "option_1", label })).toBe(
			false,
		);
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
