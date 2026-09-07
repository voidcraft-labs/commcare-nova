import { describe, expect, it } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	type Mutation,
	mutationSchema,
} from "@/lib/doc/types";
import { collectTranslationUnits, proseText } from "@/lib/domain";
import { assertAdmittedDoc } from "./admittedDoc";

function fixture(): BlueprintDoc {
	const doc = buildDoc({
		appId: "test",
		appName: "Original",
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [{ kind: "text", id: "notes", label: proseText("Notes") }],
					},
				],
			},
		],
	});
	assertAdmittedDoc(doc);
	return doc;
}
function commit(
	doc: BlueprintDoc,
	mutations: readonly Mutation[],
): BlueprintDoc {
	assertAdmittedDoc(doc);
	const wire = mutations.map((mutation) =>
		mutationSchema.parse(JSON.parse(JSON.stringify(mutation))),
	);
	const verdict = mutationCommitVerdict(doc, wire, LOOKUP_CONTEXT_UNAVAILABLE);
	expect(verdict.ok ? [] : verdict.findings).toEqual([]);
	return verdict.nextDoc;
}
function appUnit(doc: BlueprintDoc) {
	const unit = collectTranslationUnits(doc).find(
		(unit) => unit.owner.kind === "app",
	);
	if (!unit) throw new Error("Missing app name unit");
	return unit;
}
describe("app metadata commits", () => {
	it("changes name and logo without mutating the prior document, and deletes a cleared logo through JSON", () => {
		const before = fixture();
		const original = toPersistableDoc(before);
		const logo = testMediaAssetId("app-logo");
		const next = commit(before, [
			{ kind: "setAppName", name: "Clinic" },
			{ kind: "setAppLogo", logo },
		]);
		expect(next).toMatchObject({ appName: "Clinic", logo });
		expect(toPersistableDoc(before)).toEqual(original);
		const cleared = commit(next, [{ kind: "setAppLogo", logo: null }]);
		expect(Object.hasOwn(cleared, "logo")).toBe(false);
		expect(cleared.modules).toEqual(before.modules);
	});
	it("edits granular catalog metadata and returns the final retired catalog to null", () => {
		const declared = commit(fixture(), [
			{ kind: "declareCaseType", caseType: "patient" },
			{
				kind: "addCaseProperty",
				caseType: "patient",
				property: { name: "note", label: proseText("Note"), data_type: "text" },
			},
		]);
		expect(declared.caseTypes).toEqual([
			{
				name: "patient",
				properties: [
					{ name: "note", label: proseText("Note"), data_type: "text" },
				],
			},
		]);
		const changed = commit(declared, [
			{
				kind: "setCaseProperty",
				caseType: "patient",
				property: {
					name: "note",
					label: proseText("Patient note"),
					data_type: "text",
				},
			},
		]);
		expect(changed.caseTypes?.[0].properties[0].label).toEqual(
			proseText("Patient note"),
		);
		expect(
			commit(changed, [{ kind: "retireCaseType", caseType: "patient" }])
				.caseTypes,
		).toBeNull();
	});
});
// Complete Connect-mode transitions are owned by connectTargetState.test.ts;
// setting a root flag alone on an otherwise invalid Learn app proves no workflow.
describe("language and translation commits", () => {
	it("creates a target language with its copied app name atomically", () => {
		const before = fixture();
		const unit = appUnit(before);
		const next = commit(before, [
			{ kind: "addLanguage", language: { language: "spa" } },
			{
				kind: "setTranslation",
				language: "spa",
				unitId: unit.id,
				entry: {
					value: "Original",
					sourceFingerprint: unit.sourceFingerprint,
					origin: "copied",
					review: "needs-review",
					translatedFrom: "eng",
				},
			},
		]);
		expect(next.localization).toEqual({
			sourceLanguage: "eng",
			defaultLanguage: "eng",
			languageOrder: ["eng", "spa"],
			translations: {
				spa: {
					[unit.id]: {
						value: "Original",
						sourceFingerprint: unit.sourceFingerprint,
						origin: "copied",
						review: "needs-review",
						translatedFrom: "eng",
					},
				},
			},
		});
	});
	it("admits a translation against source text changed earlier in the same batch", () => {
		const before = fixture();
		const unit = appUnit({ ...before, appName: "Updated" });
		const next = commit(before, [
			{ kind: "addLanguage", language: { language: "spa" } },
			{ kind: "setAppName", name: "Updated" },
			{
				kind: "setTranslation",
				language: "spa",
				unitId: unit.id,
				entry: {
					value: "Actualizada",
					sourceFingerprint: unit.sourceFingerprint,
					origin: "human",
					review: "reviewed",
					translatedFrom: "eng",
				},
			},
		]);
		expect(next.appName).toBe("Updated");
		expect(next.localization?.translations.spa?.[unit.id]).toMatchObject({
			value: "Actualizada",
			sourceFingerprint: unit.sourceFingerprint,
		});
	});
	it("admits a field label translation when the field is born in the same batch", () => {
		const before = fixture();
		const formUuid = before.formOrder[before.moduleOrder[0]][0];
		const field = {
			uuid: testUuid("new-translated-field"),
			id: "patient_name",
			kind: "text" as const,
			label: proseText("Patient name"),
		};
		const projected = {
			...before,
			fields: { ...before.fields, [field.uuid]: field },
			fieldOrder: {
				...before.fieldOrder,
				[formUuid]: [...before.fieldOrder[formUuid], field.uuid],
			},
			fieldParent: { ...before.fieldParent, [field.uuid]: formUuid },
		};
		assertAdmittedDoc(projected);
		const unit = collectTranslationUnits(projected).find(
			(unit) =>
				unit.owner.kind === "field" && unit.owner.fieldUuid === field.uuid,
		);
		if (!unit) throw new Error("Missing born field unit");
		const next = commit(before, [
			{ kind: "addField", parentUuid: formUuid, field },
			{ kind: "addLanguage", language: { language: "spa" } },
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
		expect(next.fields[field.uuid]).toEqual(field);
		expect(next.localization?.translations.spa?.[unit.id].value).toEqual(
			proseText("Nombre del paciente"),
		);
	});
	it("relabels a single source and dematerializes the English-only result", () => {
		const french = commit(fixture(), [
			{ kind: "relabelSourceLanguage", language: { language: "fra" } },
		]);
		expect(french.localization).toEqual({
			sourceLanguage: "fra",
			defaultLanguage: "fra",
			languageOrder: ["fra"],
			translations: {},
		});
		expect(
			commit(french, [
				{ kind: "relabelSourceLanguage", language: { language: "eng" } },
			]).localization,
		).toBeUndefined();
	});
	it("fences a review against the stored translated value and advances only its source fingerprint", () => {
		const before = fixture();
		const oldUnit = appUnit(before);
		const localized = commit(before, [
			{ kind: "addLanguage", language: { language: "spa" } },
			{
				kind: "setTranslation",
				language: "spa",
				unitId: oldUnit.id,
				entry: {
					value: "Original",
					sourceFingerprint: oldUnit.sourceFingerprint,
					origin: "copied",
					review: "needs-review",
					translatedFrom: "eng",
				},
			},
			{ kind: "setAppName", name: "Updated" },
		]);
		const current = appUnit(localized);
		const review: Mutation = {
			kind: "reviewTranslation",
			language: "spa",
			unitId: current.id,
			expectedSourceFingerprint: oldUnit.sourceFingerprint,
			sourceFingerprint: current.sourceFingerprint,
			value: "Original",
		};
		expect(
			mutationCommitVerdict(
				localized,
				[{ ...review, value: "peer changed" }],
				LOOKUP_CONTEXT_UNAVAILABLE,
			).ok,
		).toBe(false);
		const next = commit(localized, [review]);
		expect(next.localization?.translations.spa?.[current.id]).toMatchObject({
			value: "Original",
			sourceFingerprint: current.sourceFingerprint,
			review: "reviewed",
		});
	});
	it("requires a new default before removing its language and removes the final target bag", () => {
		const before = commit(fixture(), [
			{ kind: "addLanguage", language: { language: "spa" } },
			{ kind: "setDefaultLanguage", code: "spa" },
		]);
		expect(before.localization?.languageOrder).toEqual(["spa", "eng"]);
		expect(
			mutationCommitVerdict(
				before,
				[{ kind: "removeLanguage", code: "spa" }],
				LOOKUP_CONTEXT_UNAVAILABLE,
			).ok,
		).toBe(false);
		const next = commit(before, [
			{ kind: "setDefaultLanguage", code: "eng" },
			{ kind: "removeLanguage", code: "spa" },
		]);
		expect(next.localization).toBeUndefined();
	});
});
