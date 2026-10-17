import { describe, expect, it } from "vitest";
import { noMatchesAfterSubmitModel } from "../noMatchesAfterSubmit";

describe("no-matches registration destinations", () => {
	it("offers native Results return and First menu for a scalar host", () => {
		const model = noMatchesAfterSubmitModel({
			firstMenu: false,
			multiple: false,
			hasMenuForms: true,
		});
		expect(model.value).toBe("return");
		expect(model.destination).toBe("Results showing the registered case");
		expect(model.options.map((option) => option.value)).toEqual([
			"return",
			"firstMenu",
		]);
	});
	it("names Search for the scalar form-only search flow", () => {
		expect(
			noMatchesAfterSubmitModel({
				firstMenu: false,
				multiple: false,
				hasMenuForms: false,
			}).destination,
		).toBe("Search");
	});
	it("offers only explicit First menu on a multiple-case host", () => {
		const model = noMatchesAfterSubmitModel({
			firstMenu: true,
			multiple: true,
			hasMenuForms: true,
		});
		expect(model.value).toBe("firstMenu");
		expect(model.options).toEqual([
			{ value: "firstMenu", label: "First menu" },
		]);
		expect(model.destination).toBe("First menu");
	});
	it("reports First menu accurately even when scalar return is available", () => {
		const model = noMatchesAfterSubmitModel({
			firstMenu: true,
			multiple: false,
			hasMenuForms: true,
		});
		expect(model.destination).toBe("First menu");
		expect(model.options).toStrictEqual([
			{ value: "return", label: "Results showing the registered case" },
			{ value: "firstMenu", label: "First menu" },
		]);
	});
});
