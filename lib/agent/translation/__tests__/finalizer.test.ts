import { produce } from "immer";
import { describe, expect, it } from "vitest";
import {
	expectAdmittedDoc,
	surveyFixture,
} from "@/lib/agent/__tests__/admittedFixture";
import {
	cloneContract,
	makeContract,
} from "@/lib/agent/design/__tests__/fixtures";
import { applyMutations } from "@/lib/doc/mutations";
import {
	collectTranslationUnits,
	effectiveAppLocalization,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { buildInitialLocalizationMutations } from "../finalizer";

describe("initial-build localization mutation planning", () => {
	it("materializes copy dependencies in topological order without blank targets", () => {
		const contract = cloneContract(makeContract());
		contract.charter.localization = {
			sourceLanguage: { language: "eng" },
			defaultLanguage: { language: "fra" },
			targets: [
				{
					language: { language: "fra" },
					seedFrom: { language: "spa" },
					strategy: "copy-only",
				},
				{
					language: { language: "spa" },
					seedFrom: { language: "eng" },
					strategy: "copy-only",
				},
			],
		};
		const source = expectAdmittedDoc(surveyFixture());
		const mutations = buildInitialLocalizationMutations({
			sourceDoc: source,
			contract,
			automaticValues: new Map(),
		});
		const localized = produce(source, (draft) => {
			applyMutations(draft, mutations);
		});
		expectAdmittedDoc(localized);
		const state = effectiveAppLocalization(localized.localization);
		// Spanish seeds from the source, so it lands first; French copies from
		// Spanish; the accepted default then moves to the front of the order.
		expect(state.languageOrder).toEqual(["fra", "eng", "spa"]);
		expect(state.sourceLanguage).toBe("eng");
		expect(state.defaultLanguage).toBe("fra");
		const unit = collectTranslationUnits(source)[0];
		if (unit === undefined) throw new Error("app-name unit missing");
		expect(state.translations.spa?.[unit.id]).toMatchObject({
			value: source.appName,
			origin: "copied",
			translatedFrom: "eng",
			review: "needs-review",
		});
		expect(state.translations.fra?.[unit.id]).toMatchObject({
			value: source.appName,
			origin: "copied",
			translatedFrom: "spa",
			review: "needs-review",
		});
	});

	it("stores complete automatic output as AI-authored Needs review values", () => {
		const contract = cloneContract(makeContract());
		contract.charter.localization = {
			sourceLanguage: { language: "eng" },
			defaultLanguage: { language: "eng" },
			targets: [
				{
					language: { language: "spa" },
					seedFrom: { language: "eng" },
					strategy: "translate-with-nova",
				},
			],
		};
		const source = expectAdmittedDoc(surveyFixture());
		const unit = collectTranslationUnits(source)[0];
		if (unit === undefined) throw new Error("app-name unit missing");
		const mutations = buildInitialLocalizationMutations({
			sourceDoc: source,
			contract,
			automaticValues: new Map([
				[
					"spa",
					new Map(
						collectTranslationUnits(source).map((item) => [
							item.id,
							item.valueKind === "text"
								? "Aplicación"
								: proseText("Aplicación"),
						]),
					),
				],
			]),
		});
		const localized = produce(source, (draft) => {
			applyMutations(draft, mutations);
		});
		expectAdmittedDoc(localized);
		expect(
			effectiveAppLocalization(localized.localization).translations.spa?.[
				unit.id
			],
		).toMatchObject({
			value: "Aplicación",
			origin: "ai",
			translatedFrom: "eng",
			review: "needs-review",
		});
	});
});
