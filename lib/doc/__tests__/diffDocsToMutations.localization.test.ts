import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { applyMutations } from "@/lib/doc/mutations";
import { mutationTargetsInvalid } from "@/lib/doc/mutationTargetAdmission";
import { type BlueprintDoc, mutationSchema } from "@/lib/doc/types";
import { collectTranslationUnits, proseText } from "@/lib/domain";

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

	it("round-trips translations whose units are born or removed in the same diff", () => {
		const moduleUuid = testUuid("localization-diff-module");
		const formUuid = testUuid("localization-diff-form");
		const fieldUuid = testUuid("localization-diff-field");
		const before: BlueprintDoc = {
			...doc(),
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
		if (unit === undefined) return;
		const after = produce(withField, (draft) => {
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
						value: proseText("Nombre del paciente"),
						sourceFingerprint: unit.sourceFingerprint,
						origin: "human",
						review: "reviewed",
						translatedFrom: "en",
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
});
