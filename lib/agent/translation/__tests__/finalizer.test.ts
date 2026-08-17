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
		const source = emptyBlueprintDoc("translation-ai");
		const unit = collectTranslationUnits(source)[0];
		if (unit === undefined) throw new Error("app-name unit missing");
		const mutations = buildInitialLocalizationMutations({
			sourceDoc: source,
			contract,
			automaticValues: new Map([["spa", new Map([[unit.id, "Aplicación"]])]]),
		});
		const localized = produce(source, (draft) => {
			applyMutations(draft, mutations);
		});
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
