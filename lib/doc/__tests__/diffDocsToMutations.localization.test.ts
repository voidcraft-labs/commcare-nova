import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
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
});
