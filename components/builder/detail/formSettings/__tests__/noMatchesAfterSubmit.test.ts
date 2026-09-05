import { describe, expect, it } from "vitest";
import { noMatchesAfterSubmitModel } from "../noMatchesAfterSubmit";

describe("no-matches registration destinations", () => {
	it("offers native Results return and App home for a scalar host", () => {
		const model = noMatchesAfterSubmitModel({
			appHome: false,
			multiple: false,
			hasMenuForms: true,
		});
		expect(model.value).toBe("return");
		expect(model.destination).toBe("Results showing the registered case");
		expect(model.options.map((option) => option.value)).toEqual([
			"return",
			"app_home",
		]);
	});
	it("names Search for the scalar form-only search flow", () => {
		expect(
			noMatchesAfterSubmitModel({
				appHome: false,
				multiple: false,
				hasMenuForms: false,
			}).destination,
		).toBe("Search");
	});
	it("offers only explicit App home on a multiple-case host", () => {
		const model = noMatchesAfterSubmitModel({
			appHome: true,
			multiple: true,
			hasMenuForms: true,
		});
		expect(model.value).toBe("app_home");
		expect(model.options).toEqual([{ value: "app_home", label: "App home" }]);
		expect(model.destination).toBe("App home");
	});
	it("reports App home accurately even when scalar return is available", () => {
		const model = noMatchesAfterSubmitModel({
			appHome: true,
			multiple: false,
			hasMenuForms: true,
		});
		expect(model.destination).toBe("App home");
		expect(model.options).toHaveLength(2);
	});
});
