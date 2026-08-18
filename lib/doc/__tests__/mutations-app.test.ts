import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
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
				language: { language: "spa" },
			},
			{
				kind: "setTranslation" as const,
				language: "spa",
				unitId: unit.id,
				entry: {
					value: unit.source,
					sourceFingerprint: unit.sourceFingerprint,
					origin: "copied" as const,
					review: "needs-review" as const,
					translatedFrom: "eng",
				},
			},
		];
		expect(mutationTargetsInvalid(doc, batch)).toBe(false);
		const next = produce(doc, (draft) => {
			applyMutations(draft, batch);
		});
		expect(next.localization).toMatchObject({
			sourceLanguage: "eng",
			languageOrder: ["eng", "spa"],
			translations: {
				spa: { [unit.id]: { value: "Original", origin: "copied" } },
			},
		});
	});

	it("admits a translation for a unit created or changed earlier in the batch", () => {
		const doc = emptyDoc();
		const renamed = produce(doc, (draft) => {
			applyMutation(draft, { kind: "setAppName", name: "Updated" });
		});
		const updatedUnit = collectTranslationUnits(renamed)[0];
		const batch = [
			{
				kind: "addLanguage" as const,
				language: { language: "spa" },
			},
			{ kind: "setAppName" as const, name: "Updated" },
			{
				kind: "setTranslation" as const,
				language: "spa",
				unitId: updatedUnit.id,
				entry: {
					value: "Actualizada",
					sourceFingerprint: updatedUnit.sourceFingerprint,
					origin: "human" as const,
					review: "reviewed" as const,
					translatedFrom: "eng",
				},
			},
		];

		expect(mutationTargetsInvalid(doc, batch)).toBe(false);
		const next = produce(doc, (draft) => {
			applyMutations(draft, batch);
		});
		expect(next.localization?.translations.spa?.[updatedUnit.id]).toMatchObject(
			{
				value: "Actualizada",
				sourceFingerprint: updatedUnit.sourceFingerprint,
			},
		);
	});

	it("admits a translation for a field born earlier in the batch", () => {
		const moduleUuid = testUuid("translated-new-field-module");
		const formUuid = testUuid("translated-new-field-form");
		const fieldUuid = testUuid("translated-new-field");
		const doc: BlueprintDoc = {
			...emptyDoc(),
			modules: {
				[moduleUuid]: {
					uuid: moduleUuid,
					id: "survey",
					name: "Survey",
				},
			},
			forms: {
				[formUuid]: {
					uuid: formUuid,
					id: "intake",
					name: "Intake",
					type: "survey",
				},
			},
			moduleOrder: [moduleUuid],
			formOrder: { [moduleUuid]: [formUuid] },
			fieldOrder: { [formUuid]: [] },
		};
		const field = {
			kind: "text" as const,
			uuid: fieldUuid,
			id: "patient_name",
			label: proseText("Patient name"),
		};
		const withField = produce(doc, (draft) => {
			applyMutation(draft, { kind: "addField", parentUuid: formUuid, field });
		});
		const unit = collectTranslationUnits(withField).find(
			(candidate) =>
				candidate.owner.kind === "field" && candidate.id.includes(fieldUuid),
		);
		expect(unit).toBeDefined();
		if (unit === undefined) return;
		const batch = [
			{
				kind: "addLanguage" as const,
				language: { language: "spa" },
			},
			{ kind: "addField" as const, parentUuid: formUuid, field },
			{
				kind: "setTranslation" as const,
				language: "spa",
				unitId: unit.id,
				entry: {
					value: proseText("Nombre del paciente"),
					sourceFingerprint: unit.sourceFingerprint,
					origin: "human" as const,
					review: "reviewed" as const,
					translatedFrom: "eng",
				},
			},
		];

		expect(mutationTargetsInvalid(doc, batch)).toBe(false);
	});

	it("relabels only the single source and dematerializes the English-only endpoint", () => {
		const french = produce(emptyDoc(), (draft) => {
			applyMutation(draft, {
				kind: "relabelSourceLanguage",
				language: { language: "fra" },
			});
		});
		expect(french.localization?.sourceLanguage).toBe("fra");
		const english = produce(french, (draft) => {
			applyMutation(draft, {
				kind: "relabelSourceLanguage",
				language: { language: "eng" },
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
				sourceLanguage: "eng",
				defaultLanguage: "eng",
				languageOrder: ["eng", "spa"],
				translations: {
					spa: {
						[oldUnit.id]: {
							value: "Original",
							sourceFingerprint: oldUnit.sourceFingerprint,
							origin: "copied",
							review: "needs-review",
							translatedFrom: "eng",
						},
					},
				},
			},
		};
		localized.appName = "Updated";
		const currentUnit = collectTranslationUnits(localized)[0];
		const review = {
			kind: "reviewTranslation" as const,
			language: "spa",
			unitId: currentUnit.id,
			expectedSourceFingerprint: oldUnit.sourceFingerprint,
			sourceFingerprint: currentUnit.sourceFingerprint,
			value: "Original",
		};
		expect(mutationTargetsInvalid(localized, [review])).toBe(false);
		const next = produce(localized, (draft) => {
			applyMutation(draft, review);
		});
		expect(next.localization?.translations.spa?.[currentUnit.id]).toMatchObject(
			{
				sourceFingerprint: currentUnit.sourceFingerprint,
				review: "reviewed",
			},
		);
		expect(
			mutationTargetsInvalid(localized, [{ ...review, value: "changed" }]),
		).toBe(true);
	});

	it("requires changing the default before removing that target", () => {
		const doc = produce(emptyDoc(), (draft) => {
			applyMutations(draft, [
				{
					kind: "addLanguage",
					language: { language: "spa" },
				},
				{ kind: "setDefaultLanguage", code: "spa" },
			]);
		});
		expect(
			mutationTargetsInvalid(doc, [{ kind: "removeLanguage", code: "spa" }]),
		).toBe(true);
		expect(
			mutationTargetsInvalid(doc, [
				{ kind: "setDefaultLanguage", code: "eng" },
				{ kind: "removeLanguage", code: "spa" },
			]),
		).toBe(false);
	});
});
