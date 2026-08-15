import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import { applyMutation, applyMutations } from "@/lib/doc/mutations";
import { mutationTargetsInvalid } from "@/lib/doc/mutationTargetAdmission";
import type { BlueprintDoc } from "@/lib/doc/types";
import { collectTranslationUnits } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

function emptyDoc(): BlueprintDoc {
	return {
		appId: "test",
		appName: "Original",
		connectType: null,
		caseTypes: null,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		fieldParent: {},
	};
}

describe("applyMutation: setAppName", () => {
	it("updates appName", () => {
		const next = produce(emptyDoc(), (d) => {
			applyMutation(d, { kind: "setAppName", name: "Renamed" });
		});
		expect(next.appName).toBe("Renamed");
	});

	it("does not mutate the input doc", () => {
		const doc = emptyDoc();
		produce(doc, (d) => {
			applyMutation(d, { kind: "setAppName", name: "Renamed" });
		});
		expect(doc.appName).toBe("Original");
	});
});

describe("applyMutation: setConnectType", () => {
	it("sets learn", () => {
		const next = produce(emptyDoc(), (d) => {
			applyMutation(d, { kind: "setConnectType", connectType: "learn" });
		});
		expect(next.connectType).toBe("learn");
	});

	it("sets null to disable connect", () => {
		const withLearn: BlueprintDoc = { ...emptyDoc(), connectType: "learn" };
		const next = produce(withLearn, (d) => {
			applyMutation(d, { kind: "setConnectType", connectType: null });
		});
		expect(next.connectType).toBeNull();
	});
});

describe("applyMutation: granular case-type catalog", () => {
	it("declares a type and adds a property without a whole-catalog mutation", () => {
		const next = produce(emptyDoc(), (d) => {
			applyMutation(d, { kind: "declareCaseType", caseType: "patient" });
			applyMutation(d, {
				kind: "addCaseProperty",
				caseType: "patient",
				property: { name: "name", label: proseText("Name") },
			});
		});
		expect(next.caseTypes).toEqual([
			{
				name: "patient",
				properties: [{ name: "name", label: proseText("Name") }],
			},
		]);
	});

	it("retiring the last type restores the canonical null catalog", () => {
		const withTypes: BlueprintDoc = {
			...emptyDoc(),
			caseTypes: [{ name: "a", properties: [] }],
		};
		const next = produce(withTypes, (d) => {
			applyMutation(d, { kind: "retireCaseType", caseType: "a" });
		});
		expect(next.caseTypes).toBeNull();
	});
});

describe("applyMutation: setAppLogo", () => {
	it("sets the logo to an asset id", () => {
		const logo = testMediaAssetId("asset-logo");
		const next = produce(emptyDoc(), (d) => {
			applyMutation(d, { kind: "setAppLogo", logo });
		});
		expect(next.logo).toBe(logo);
	});

	it("clears the logo by mapping null to undefined (not a literal null)", () => {
		const withLogo: BlueprintDoc = {
			...emptyDoc(),
			logo: testMediaAssetId("asset-logo"),
		};
		const next = produce(withLogo, (d) => {
			applyMutation(d, { kind: "setAppLogo", logo: null });
		});
		// `logo` is `.optional()` on the doc schema — a cleared logo must
		// drop to `undefined`, never persist as `null` (which the schema
		// would reject on the next round-trip).
		expect(next.logo).toBeUndefined();
	});

	it("does not mutate the input doc", () => {
		const doc = emptyDoc();
		produce(doc, (d) => {
			applyMutation(d, {
				kind: "setAppLogo",
				logo: testMediaAssetId("asset-logo"),
			});
		});
		expect(doc.logo).toBeUndefined();
	});
});

describe("applyMutation: app localization", () => {
	it("adds a target and copies one current source unit in the same batch", () => {
		const doc = emptyDoc();
		const unit = collectTranslationUnits(doc)[0];
		const batch = [
			{
				kind: "addLanguage" as const,
				language: { code: "es", name: "Español", direction: "ltr" as const },
			},
			{
				kind: "setTranslation" as const,
				language: "es",
				unitId: unit.id,
				entry: {
					value: unit.source,
					sourceFingerprint: unit.sourceFingerprint,
					origin: "copied" as const,
					review: "needs-review" as const,
					translatedFrom: "en",
				},
			},
		];
		expect(mutationTargetsInvalid(doc, batch)).toBe(false);
		const next = produce(doc, (draft) => {
			applyMutations(draft, batch);
		});
		expect(next.localization).toMatchObject({
			sourceLanguage: "en",
			languageOrder: ["en", "es"],
			translations: {
				es: { [unit.id]: { value: "Original", origin: "copied" } },
			},
		});
	});

	it("relabels only the single source and canonicalizes legacy English", () => {
		const french = produce(emptyDoc(), (draft) => {
			applyMutation(draft, {
				kind: "relabelSourceLanguage",
				language: { code: "fra", name: "Français", direction: "ltr" },
			});
		});
		expect(french.localization?.sourceLanguage).toBe("fra");
		const english = produce(french, (draft) => {
			applyMutation(draft, {
				kind: "relabelSourceLanguage",
				language: { code: "en", name: "English", direction: "ltr" },
			});
		});
		expect(english.localization).toBeUndefined();
	});

	it("fences review against the exact stale value and advances its fingerprint", () => {
		const original = emptyDoc();
		const oldUnit = collectTranslationUnits(original)[0];
		const localized: BlueprintDoc = {
			...original,
			localization: {
				sourceLanguage: "en",
				defaultLanguage: "en",
				languageOrder: ["en", "es"],
				languages: {
					en: { code: "en", name: "English", direction: "ltr" },
					es: { code: "es", name: "Español", direction: "ltr" },
				},
				translations: {
					es: {
						[oldUnit.id]: {
							value: "Original",
							sourceFingerprint: oldUnit.sourceFingerprint,
							origin: "copied",
							review: "needs-review",
							translatedFrom: "en",
						},
					},
				},
			},
		};
		localized.appName = "Updated";
		const currentUnit = collectTranslationUnits(localized)[0];
		const review = {
			kind: "reviewTranslation" as const,
			language: "es",
			unitId: currentUnit.id,
			expectedSourceFingerprint: oldUnit.sourceFingerprint,
			sourceFingerprint: currentUnit.sourceFingerprint,
			value: "Original",
		};
		expect(mutationTargetsInvalid(localized, [review])).toBe(false);
		const next = produce(localized, (draft) => {
			applyMutation(draft, review);
		});
		expect(next.localization?.translations.es?.[currentUnit.id]).toMatchObject({
			sourceFingerprint: currentUnit.sourceFingerprint,
			review: "reviewed",
		});
		expect(
			mutationTargetsInvalid(localized, [{ ...review, value: "changed" }]),
		).toBe(true);
	});

	it("requires changing the default before removing that target", () => {
		const doc = produce(emptyDoc(), (draft) => {
			applyMutations(draft, [
				{
					kind: "addLanguage",
					language: { code: "es", name: "Español", direction: "ltr" },
				},
				{ kind: "setDefaultLanguage", code: "es" },
			]);
		});
		expect(
			mutationTargetsInvalid(doc, [{ kind: "removeLanguage", code: "es" }]),
		).toBe(true);
		expect(
			mutationTargetsInvalid(doc, [
				{ kind: "setDefaultLanguage", code: "en" },
				{ kind: "removeLanguage", code: "es" },
			]),
		).toBe(false);
	});
});
