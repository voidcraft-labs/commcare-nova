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
import { type BlueprintDoc, mutationSchema } from "@/lib/doc/types";
import { collectTranslationUnits, proseText } from "@/lib/domain";
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
