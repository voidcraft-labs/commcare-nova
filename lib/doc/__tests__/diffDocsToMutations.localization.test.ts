import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	addLanguageMutation,
	heldLanguageWireCodes,
} from "@/lib/doc/languageMutations";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import { mutationTargetsInvalid } from "@/lib/doc/mutationTargetAdmission";
import { emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import { type BlueprintDoc, mutationSchema } from "@/lib/doc/types";
import {
	collectTranslationUnits,
	proseText,
	translationSourceFingerprint,
} from "@/lib/domain";
import { assertAdmittedDoc } from "./admittedDoc";

function doc(): BlueprintDoc {
	const value = buildDoc({
		appId: "localization-diff",
		appName: "Clinic",
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Intake",
						type: "survey",
						fields: [{ kind: "text", id: "notes", label: proseText("Notes") }],
					},
				],
			},
		],
	});
	assertAdmittedDoc(value);
	return value;
}

function wireReplay(source: BlueprintDoc, target: BlueprintDoc): BlueprintDoc {
	assertAdmittedDoc(source);
	assertAdmittedDoc(target);
	const onWire = JSON.parse(
		JSON.stringify(diffDocsToMutations(source, target)),
	);
	const mutations = onWire.map((mutation: unknown) =>
		mutationSchema.parse(mutation),
	);
	const verdict = mutationCommitVerdict(
		source,
		mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok ? [] : verdict.findings).toEqual([]);
	return verdict.nextDoc;
}

describe("diffDocsToMutations localization", () => {
	it("constructs a translated installation from an empty app and removes it with its language", () => {
		const empty = emptyBlueprintDoc("localization-diff");
		const uuid = testUuid("spanish-installation");
		const spanish = produce(doc(), (draft) => {
			applyMutations(draft, [
				{ kind: "addLanguage", language: { language: "spa" }, wireCode: "es" },
				{
					kind: "setAppSettings",
					settings: {
						installationProfile: {
							operation: "add",
							profile: {
								uuid,
								name: "Field",
								languages: ["spa"],
								requiresPracticeWorker: false,
							},
						},
					},
				},
			]);
		});
		const french = produce(spanish, (draft) => {
			applyMutations(draft, [
				{ kind: "addLanguage", language: { language: "fra" }, wireCode: "fr" },
				{
					kind: "setAppSettings",
					settings: {
						installationProfile: {
							operation: "update",
							uuid,
							patch: { languages: ["fra"] },
						},
					},
				},
				{ kind: "removeLanguage", code: "spa" },
			]);
		});
		const birth = mutationCommitVerdict(
			empty,
			diffDocsToMutations(empty, spanish),
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(birth.ok ? [] : birth.findings).toEqual([]);
		expect(toPersistableDoc(birth.nextDoc)).toEqual(toPersistableDoc(spanish));

		for (const [before, after] of [
			[spanish, doc()],
			[spanish, french],
			[french, spanish],
		] as const) {
			expect(toPersistableDoc(wireReplay(before, after))).toEqual(
				toPersistableDoc(after),
			);
		}
	});

	it("replays a profile's choice of language even when relabeling remaps its old language", () => {
		const uuid = testUuid("original-installation");
		const before = produce(doc(), (draft) => {
			applyMutations(draft, [
				{
					kind: "setAppSettings",
					settings: {
						installationProfile: {
							operation: "add",
							profile: {
								uuid,
								name: "Field",
								languages: ["eng"],
								requiresPracticeWorker: false,
							},
						},
					},
				},
			]);
		});
		const after = produce(before, (draft) => {
			applyMutations(draft, [
				{
					kind: "relabelSourceLanguage",
					language: { language: "fra" },
					wireCode: "fr",
				},
				{ kind: "addLanguage", language: { language: "eng" }, wireCode: "en" },
				{
					kind: "setAppSettings",
					settings: {
						installationProfile: {
							operation: "update",
							uuid,
							patch: { languages: ["eng"] },
						},
					},
				},
			]);
		});
		expect(toPersistableDoc(wireReplay(before, after))).toEqual(
			toPersistableDoc(after),
		);
		expect(toPersistableDoc(wireReplay(after, before))).toEqual(
			toPersistableDoc(before),
		);
	});

	it("round-trips adding copied translations and removing the last target", () => {
		const before = doc();
		const unit = collectTranslationUnits(before).find(
			(unit) => unit.owner.kind === "app",
		);
		if (!unit) throw new Error("Missing app translation unit");
		const after = produce(before, (draft) => {
			applyMutations(draft, [
				{
					kind: "addLanguage",
					language: { language: "spa" },
					wireCode: "es",
				},
				{
					kind: "setTranslation",
					language: "spa",
					unitId: unit.id,
					entry: {
						value: "Clínica",
						sourceFingerprint: unit.sourceFingerprint,
						origin: "human",
						review: "reviewed",
						translatedFrom: "eng",
					},
				},
			]);
		});
		expect(toPersistableDoc(wireReplay(before, after))).toEqual(
			toPersistableDoc(after),
		);
		expect(toPersistableDoc(wireReplay(after, before))).toEqual(
			toPersistableDoc(before),
		);
	});

	it("rebases original text and retains another language's provenance, including through persisted inverse replay", () => {
		const original = doc();
		const units = collectTranslationUnits(original);
		const name = units.find((unit) => unit.role === "app-name");
		const label = units.find((unit) => unit.role === "field-label");
		if (!name || !label)
			throw new Error("Expected the original app name and field label");
		const before = produce(original, (draft) => {
			applyMutations(draft, [
				{ kind: "addLanguage", language: { language: "fra" }, wireCode: "fr" },
				{
					kind: "addLanguage",
					language: { kind: "project", language: "qaa" },
					wireCode: "qaa",
				},
				{
					kind: "setProjectLanguageDirection",
					code: "project:qaa",
					direction: "rtl",
				},
				{
					kind: "setTranslation",
					language: "fra",
					unitId: name.id,
					entry: {
						value: "Clinique",
						sourceFingerprint: name.sourceFingerprint,
						origin: "human",
						review: "reviewed",
						translatedFrom: "eng",
					},
				},
				{
					kind: "setTranslation",
					language: "project:qaa",
					unitId: name.id,
					entry: {
						value: "Klinik",
						sourceFingerprint: name.sourceFingerprint,
						origin: "ai",
						review: "needs-review",
						translatedFrom: "eng",
					},
				},
				{
					kind: "setTranslation",
					language: "project:qaa",
					unitId: label.id,
					entry: {
						value: label.source,
						sourceFingerprint: label.sourceFingerprint,
						origin: "copied",
						review: "needs-review",
						translatedFrom: "eng",
					},
				},
			]);
		});
		const after = produce(before, (draft) => {
			applyMutations(draft, [
				{ kind: "rebaseSourceLanguage", from: "eng", to: "fra" },
			]);
		});
		expect(after.appName).toBe("Clinique");
		expect(after.localization?.translations.eng[name.id]?.value).toBe("Clinic");
		expect(after.localization?.translations["project:qaa"]).toEqual({
			[name.id]: {
				value: "Klinik",
				sourceFingerprint: translationSourceFingerprint("text", "Clinique"),
				origin: "ai",
				review: "needs-review",
				translatedFrom: "eng",
			},
			[label.id]: before.localization?.translations["project:qaa"][label.id],
		});
		expect(after.localization?.rtlProjectLanguages).toEqual({
			"project:qaa": true,
		});
		expect(toPersistableDoc(wireReplay(before, after))).toEqual(
			toPersistableDoc(after),
		);
		expect(toPersistableDoc(wireReplay(after, before))).toEqual(
			toPersistableDoc(before),
		);
	});

	it("round-trips the only supported source-language relabel", () => {
		const before = doc();
		const after = produce(before, (draft) => {
			applyMutations(draft, [
				{
					kind: "relabelSourceLanguage",
					language: { language: "fra" },
					wireCode: "fra",
				},
			]);
		});
		expect(toPersistableDoc(wireReplay(before, after))).toEqual(
			toPersistableDoc(after),
		);
		expect(toPersistableDoc(wireReplay(after, before))).toEqual(
			toPersistableDoc(before),
		);
	});

	it("reaches another source with more languages from a one-language app, the old source among them", () => {
		const before = doc();
		const unit = collectTranslationUnits(before).find(
			(unit) => unit.owner.kind === "app",
		);
		if (!unit) throw new Error("Missing app translation unit");
		const after = produce(before, (draft) => {
			applyMutations(draft, [
				{
					kind: "relabelSourceLanguage",
					language: { language: "spa" },
					wireCode: "es",
				},
				{
					kind: "addLanguage",
					language: { language: "eng" },
					wireCode: "en",
				},
			]);
		});
		const english = produce(after, (draft) => {
			applyMutations(draft, [
				{
					kind: "setTranslation",
					language: "eng",
					unitId: unit.id,
					entry: {
						value: "Clinic in English",
						sourceFingerprint: unit.sourceFingerprint,
						origin: "human",
						review: "reviewed",
						translatedFrom: "spa",
					},
				},
			]);
		});
		expect(english.localization?.languageOrder).toEqual(["spa", "eng"]);
		expect(toPersistableDoc(wireReplay(before, english))).toEqual(
			toPersistableDoc(english),
		);
	});

	it("reaches a source that stands third in the order from a one-language app", () => {
		const before = doc();
		const after = produce(before, (draft) => {
			applyMutations(draft, [
				{
					kind: "relabelSourceLanguage",
					language: { language: "spa" },
					wireCode: "es",
				},
				{
					kind: "addLanguage",
					language: { language: "eng" },
					wireCode: "en",
				},
				{
					kind: "addLanguage",
					language: { language: "fra" },
					wireCode: "fr",
				},
				{ kind: "setDefaultLanguage", code: "fra" },
				{ kind: "setDefaultLanguage", code: "eng" },
			]);
		});
		expect(after.localization).toMatchObject({
			sourceLanguage: "spa",
			defaultLanguage: "eng",
			languageOrder: ["eng", "fra", "spa"],
			wireCodes: { eng: "en", fra: "fr", spa: "es" },
		});
		expect(toPersistableDoc(wireReplay(before, after))).toEqual(
			toPersistableDoc(after),
		);
	});

	it("reorders languages an app already holds", () => {
		const languages = produce(doc(), (draft) => {
			applyMutations(draft, [
				{
					kind: "addLanguage",
					language: { language: "fra" },
					wireCode: "fr",
				},
				{
					kind: "addLanguage",
					language: { language: "spa" },
					wireCode: "es",
				},
			]);
		});
		const reordered = produce(languages, (draft) => {
			applyMutations(draft, [
				{ kind: "setDefaultLanguage", code: "spa" },
				{ kind: "setDefaultLanguage", code: "fra" },
			]);
		});
		expect(languages.localization?.languageOrder).toEqual([
			"eng",
			"fra",
			"spa",
		]);
		expect(reordered.localization?.languageOrder).toEqual([
			"fra",
			"spa",
			"eng",
		]);
		expect(toPersistableDoc(wireReplay(languages, reordered))).toEqual(
			toPersistableDoc(reordered),
		);
		expect(toPersistableDoc(wireReplay(reordered, languages))).toEqual(
			toPersistableDoc(languages),
		);
	});

	it("round-trips translations whose units are born or removed in the same diff", () => {
		const before = doc();
		const formUuid = before.formOrder[before.moduleOrder[0]][0];
		const fieldUuid = testUuid("localization-diff-field");
		const field = {
			kind: "text" as const,
			uuid: fieldUuid,
			id: "patient_name",
			label: proseText("Patient name"),
		};
		const withField = produce(before, (draft) => {
			applyMutations(draft, [
				{ kind: "addField", parentUuid: formUuid, field },
			]);
		});
		const unit = collectTranslationUnits(withField).find(
			(candidate) =>
				candidate.owner.kind === "field" && candidate.id.includes(fieldUuid),
		);
		expect(unit).toBeDefined();
		if (unit === undefined) throw new Error("Missing field translation unit");
		const after = produce(withField, (draft) => {
			applyMutations(draft, [
				{
					kind: "addLanguage",
					language: { language: "spa" },
					wireCode: "es",
				},
				{
					kind: "setTranslation",
					language: "spa",
					unitId: unit.id,
					entry: {
						value: proseText("Nombre del paciente"),
						sourceFingerprint: unit.sourceFingerprint,
						origin: "human",
						review: "reviewed",
						translatedFrom: "eng",
					},
				},
			]);
		});
		const forward = diffDocsToMutations(before, after);
		const reverse = diffDocsToMutations(after, before);

		expect(mutationTargetsInvalid(before, forward)).toBe(false);
		expect(mutationTargetsInvalid(after, reverse)).toBe(false);
		expect(toPersistableDoc(wireReplay(before, after))).toEqual(
			toPersistableDoc(after),
		);
		expect(toPersistableDoc(wireReplay(after, before))).toEqual(
			toPersistableDoc(before),
		);
	});

	it("admits the birth and inverse of a historical English code alongside a project language using en", () => {
		const empty = doc();
		const adopted = produce(empty, (draft) => {
			applyMutations(draft, [
				{
					kind: "relabelSourceLanguage",
					language: { language: "eng" },
					wireCode: "eng",
				},
				{
					kind: "addLanguage",
					language: { kind: "project", language: "en" },
					wireCode: "en",
				},
				{ kind: "moveLanguage", code: "project:en", after: null },
				{
					kind: "setProjectLanguageDirection",
					code: "project:en",
					direction: "rtl",
				},
			]);
		});
		expect(toPersistableDoc(wireReplay(empty, adopted))).toEqual(
			toPersistableDoc(adopted),
		);
		expect(toPersistableDoc(wireReplay(adopted, empty))).toEqual(
			toPersistableDoc(empty),
		);
	});

	it("restores a removed language's exact code where a fresh mint would give another", () => {
		const simplified = { language: "cmn", script: "Hans" };
		const traditional = { language: "cmn", script: "Hant" };
		const both = produce(doc(), (draft) => {
			const first = addLanguageMutation(
				heldLanguageWireCodes(draft),
				simplified,
			);
			const second = addLanguageMutation(
				new Set([...heldLanguageWireCodes(draft), first.wireCode]),
				traditional,
			);
			applyMutations(draft, [first, second]);
		});
		const traditionalOnly = produce(both, (draft) => {
			applyMutations(draft, [{ kind: "removeLanguage", code: "cmn-Hans" }]);
		});
		expect(traditionalOnly.localization?.wireCodes).toEqual({
			eng: "en",
			"cmn-Hant": "cmn-hant",
		});
		const englishOnly = wireReplay(traditionalOnly, doc());
		// A fresh mint for Traditional Mandarin against English alone gives
		// zho; the undo carries the code the language had.
		expect(
			addLanguageMutation(heldLanguageWireCodes(englishOnly), traditional)
				.wireCode,
		).toBe("zho");
		expect(
			wireReplay(englishOnly, traditionalOnly).localization?.wireCodes,
		).toEqual({ eng: "en", "cmn-Hant": "cmn-hant" });
	});

	it("restores a historical stale draft and the independent wording read by workers, fenced against a changed source or prior draft", () => {
		const original = doc();
		const unit = collectTranslationUnits(original).find(
			(candidate) => candidate.role === "app-name",
		);
		if (!unit) throw Error("Missing name");
		const without = produce(original, (draft) => {
			applyMutations(draft, [
				{
					kind: "addLanguage",
					language: { kind: "project", language: "qaa" },
					wireCode: "qaa",
				},
			]);
		});
		const withDraft = produce(without, (draft) => {
			const entries = draft.localization?.translations["project:qaa"];
			if (!entries) throw Error("Missing project language");
			entries[unit.id] = {
				value: "Klinik",
				origin: "ai",
				review: "needs-review",
				translatedFrom: "eng",
				sourceFingerprint: translationSourceFingerprint(
					"text",
					"Earlier source",
				),
				workerFallback: {
					sourceFingerprint: unit.sourceFingerprint,
					value: "Earlier worker wording",
				},
			};
		});
		expect(toPersistableDoc(wireReplay(without, withDraft))).toEqual(
			toPersistableDoc(withDraft),
		);
		expect(toPersistableDoc(wireReplay(withDraft, without))).toEqual(
			toPersistableDoc(without),
		);
		const restore = diffDocsToMutations(without, withDraft);
		const changed = produce(without, (draft) => {
			draft.appName = "Changed again";
		});
		expect(mutationTargetsInvalid(changed, restore)).toBe(true);
		expect(mutationTargetsInvalid(withDraft, restore)).toBe(true);
	});
	it("restores a source change in both directions when the incoming source needs the outgoing language's code", () => {
		const before = produce(doc(), (draft) => {
			applyMutations(draft, [
				{ kind: "addLanguage", language: { language: "fra" }, wireCode: "fr" },
			]);
		});
		const after = produce(before, (draft) => {
			draft.localization = {
				sourceLanguage: "project:en",
				defaultLanguage: "project:en",
				languageOrder: ["project:en", "fra"],
				wireCodes: { "project:en": "en", fra: "fr" },
				translations: { fra: {} },
			};
		});
		expect(toPersistableDoc(wireReplay(before, after))).toEqual(
			toPersistableDoc(after),
		);
		expect(toPersistableDoc(wireReplay(after, before))).toEqual(
			toPersistableDoc(before),
		);
	});
	it("exchanges occupied spellings without moving source text, translations or project codes", () => {
		const before = produce(doc(), (draft) => {
			applyMutations(draft, [
				{ kind: "addLanguage", language: { language: "fra" }, wireCode: "fr" },
				{
					kind: "addLanguage",
					language: { kind: "project", language: "qaa" },
					wireCode: "qaa",
				},
			]);
		});
		const after = produce(before, (draft) => {
			if (draft.localization) {
				draft.localization.wireCodes.eng = "fr";
				draft.localization.wireCodes.fra = "en";
			}
		});
		expect(diffDocsToMutations(before, after)).toEqual([
			{
				kind: "rebindLanguageCodes",
				changes: [
					{ language: "eng", from: "en", to: "fr" },
					{ language: "fra", from: "fr", to: "en" },
				],
			},
		]);
		expect(toPersistableDoc(wireReplay(before, after))).toEqual(
			toPersistableDoc(after),
		);
		expect(toPersistableDoc(wireReplay(after, before))).toEqual(
			toPersistableDoc(before),
		);
		for (const changes of [
			[{ language: "eng", from: "en", to: "fr" }],
			[{ language: "eng", from: "eng", to: "eng-" }],
			[{ language: "project:qaa", from: "qaa", to: "qq" }],
		]) {
			expect(
				mutationTargetsInvalid(before, [
					{ kind: "rebindLanguageCodes", changes },
				]),
			).toBe(true);
		}
	});
	it("removes a language before adding the one that takes its code", () => {
		const simplifiedOnly = produce(doc(), (draft) => {
			applyMutations(draft, [
				{
					kind: "addLanguage",
					language: { language: "cmn", script: "Hans" },
					wireCode: "zho",
				},
			]);
		});
		const traditionalOnly = produce(doc(), (draft) => {
			applyMutations(draft, [
				{
					kind: "addLanguage",
					language: { language: "cmn", script: "Hant" },
					wireCode: "zho",
				},
			]);
		});
		expect(
			toPersistableDoc(wireReplay(simplifiedOnly, traditionalOnly)),
		).toEqual(toPersistableDoc(traditionalOnly));
		expect(
			toPersistableDoc(wireReplay(traditionalOnly, simplifiedOnly)),
		).toEqual(toPersistableDoc(simplifiedOnly));
	});

	it.each([
		["the dropped language", "the added language"],
		["the dropped language", "the source language"],
		["the source language", "the added language"],
	] as const)(
		"round-trips a language taking the code of one that leaves when %s is the default and the target's is %s",
		(fromDefault, toDefault) => {
			function holding(
				language: { language: string; script: string },
				isDefault: boolean,
			): BlueprintDoc {
				return produce(doc(), (draft) => {
					applyMutations(draft, [
						{ kind: "addLanguage", language, wireCode: "zho" },
						...(isDefault
							? [
									{
										kind: "setDefaultLanguage" as const,
										code: `${language.language}-${language.script}`,
									},
								]
							: []),
					]);
				});
			}
			const dropped = holding(
				{ language: "cmn", script: "Hans" },
				fromDefault === "the dropped language",
			);
			const added = holding(
				{ language: "cmn", script: "Hant" },
				toDefault === "the added language",
			);
			expect(toPersistableDoc(wireReplay(dropped, added))).toEqual(
				toPersistableDoc(added),
			);
			expect(toPersistableDoc(wireReplay(added, dropped))).toEqual(
				toPersistableDoc(dropped),
			);
		},
	);
});
