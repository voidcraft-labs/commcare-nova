import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { applyMutations } from "@/lib/doc/mutations";
import { type BlueprintDoc, mutationSchema } from "@/lib/doc/types";
import { collectTranslationUnits } from "@/lib/domain";

function doc(): BlueprintDoc {
	return {
		appId: "localization-diff",
		appName: "Clinic",
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

function wireReplay(source: BlueprintDoc, target: BlueprintDoc): BlueprintDoc {
	const onWire = JSON.parse(
		JSON.stringify(diffDocsToMutations(source, target)),
	);
	const mutations = onWire.map((mutation: unknown) =>
		mutationSchema.parse(mutation),
	);
	return produce(source, (draft) => {
		applyMutations(draft, mutations);
	});
}

describe("diffDocsToMutations localization", () => {
	it("round-trips adding copied translations and removing the last target", () => {
		const before = doc();
		const unit = collectTranslationUnits(before)[0];
		const after = produce(before, (draft) => {
			applyMutations(draft, [
				{
					kind: "addLanguage",
					language: { code: "es", name: "Español", direction: "ltr" },
				},
				{
					kind: "setTranslation",
					language: "es",
					unitId: unit.id,
					entry: {
						value: "Clínica",
						sourceFingerprint: unit.sourceFingerprint,
						origin: "human",
						review: "reviewed",
						translatedFrom: "en",
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
					language: { code: "fra", name: "Français", direction: "ltr" },
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
});
