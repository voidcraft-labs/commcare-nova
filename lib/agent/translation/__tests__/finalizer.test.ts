import { produce } from "immer";
import { describe, expect, it } from "vitest";
import {
	cloneContract,
	makeContract,
} from "@/lib/agent/design/__tests__/fixtures";
import { applyMutations } from "@/lib/doc/mutations";
import { emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import {
	collectTranslationUnits,
	effectiveAppLocalization,
} from "@/lib/domain";
import { buildInitialLocalizationMutations } from "../finalizer";

describe("initial-build localization mutation planning", () => {
	it("materializes copy dependencies in topological order without blank targets", () => {
		const contract = cloneContract(makeContract());
		contract.charter.localization = {
			sourceLanguage: { code: "en", name: "English", direction: "ltr" },
			defaultLanguage: "fr",
			targets: [
				{
					language: { code: "fr", name: "Français", direction: "ltr" },
					seedFrom: "es",
					strategy: "copy-only",
				},
				{
					language: { code: "es", name: "Español", direction: "ltr" },
					seedFrom: "en",
					strategy: "copy-only",
				},
			],
		};
		const source = emptyBlueprintDoc("translation-copy");
		const mutations = buildInitialLocalizationMutations({
			sourceDoc: source,
			contract,
			automaticValues: new Map(),
		});
		const localized = produce(source, (draft) => {
			applyMutations(draft, mutations);
		});
		const state = effectiveAppLocalization(localized.localization);
		expect(state.languageOrder).toEqual(["fr", "en", "es"]);
		const unit = collectTranslationUnits(source)[0];
		if (unit === undefined) throw new Error("app-name unit missing");
		expect(state.translations.es?.[unit.id]).toMatchObject({
			value: source.appName,
			origin: "copied",
			translatedFrom: "en",
			review: "needs-review",
		});
		expect(state.translations.fr?.[unit.id]).toMatchObject({
			value: source.appName,
			origin: "copied",
			translatedFrom: "es",
			review: "needs-review",
		});
	});

	it("stores complete automatic output as AI-authored Needs review values", () => {
		const contract = cloneContract(makeContract());
		contract.charter.localization = {
			sourceLanguage: { code: "en", name: "English", direction: "ltr" },
			defaultLanguage: "en",
			targets: [
				{
					language: { code: "es", name: "Español", direction: "ltr" },
					seedFrom: "en",
					strategy: "translate-with-nova",
				},
			],
		};
		const source = emptyBlueprintDoc("translation-ai");
		const unit = collectTranslationUnits(source)[0];
		if (unit === undefined) throw new Error("app-name unit missing");
		const mutations = buildInitialLocalizationMutations({
			sourceDoc: source,
			contract,
			automaticValues: new Map([["es", new Map([[unit.id, "Aplicación"]])]]),
		});
		const localized = produce(source, (draft) => {
			applyMutations(draft, mutations);
		});
		expect(
			effectiveAppLocalization(localized.localization).translations.es?.[
				unit.id
			],
		).toMatchObject({
			value: "Aplicación",
			origin: "ai",
			translatedFrom: "en",
			review: "needs-review",
		});
	});
});
