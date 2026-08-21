import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { proseText } from "@/lib/domain/prose";
import { isMintedPlaceholder } from "../OptionsEditor";

function option(value: string, label: string) {
	return { uuid: testUuid("opt"), value, label: proseText(label) };
}

describe("isMintedPlaceholder", () => {
	it("recognizes a row exactly as Nova minted it", () => {
		expect(isMintedPlaceholder(option("option_1", "Option 1"))).toBe(true);
		expect(isMintedPlaceholder(option("option_12", "Option 12"))).toBe(true);
	});

	it("treats a hand-edited value or label as chosen", () => {
		expect(isMintedPlaceholder(option("yes", "Option 1"))).toBe(false);
		expect(isMintedPlaceholder(option("option_1", "Yes"))).toBe(false);
		// The number has to match: a renumbered row was not minted this way.
		expect(isMintedPlaceholder(option("option_1", "Option 2"))).toBe(false);
	});
});
