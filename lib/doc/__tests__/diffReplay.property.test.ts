/**
 * `diffDocsToMutations` replays the case-type catalog's tail of its batch on
 * top of the structural replay it already made where `prev` holds no
 * translation, rather than replaying the whole batch again from the start.
 * Held here: over the documents the oracle
 * corpora draw, each built from the empty one and from an earlier state of
 * itself (its construction batch cut short), the
 * catalog mutations of a diff stand in one run after the structural ones,
 * and that run applied on top of the structural part's document is the
 * whole joined batch's document, compared as ordered JSON, derived parts and
 * key order included.
 *
 * A plausible failure: a batch-level step of the reducer (the translation
 * prune, the English-only collapse, the parent index, the menus placed
 * above) that the catalog tail meets differently on its own, which would give
 * the after-submit residual or the localization diff another base. The
 * translation prune is one: the last describe holds a `prev` with a
 * translation, where the diff replays the whole batch as one.
 */
import * as fc from "fast-check";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { advancedDocArbitrary } from "@/lib/commcare/__tests__/advancedDocArbitrary";
import { menuScreenDocArbitrary } from "@/lib/commcare/__tests__/menuScreenDocArbitrary";
import { suiteDocArbitrary } from "@/lib/commcare/__tests__/suiteDocArbitrary";
import { blueprintDocArbitrary } from "@/lib/commcare/__tests__/xformDocArbitrary";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { applyMutations } from "@/lib/doc/mutations";
import { emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { plainColumn } from "@/lib/domain/modules";
import { proseText } from "@/lib/domain/prose";
import {
	casePropertyOptionTranslationUnitId,
	translationUnitsById,
} from "@/lib/domain/translationUnits";

const CATALOG_KINDS: ReadonlySet<Mutation["kind"]> = new Set([
	"declareCaseType",
	"setCaseTypeMeta",
	"addCaseProperty",
	"setCaseProperty",
	"removeCaseProperty",
	"retireCaseType",
]);

/** Every own enumerable key in its order, a Map's and a Set's entries in theirs. */
function orderedJson(value: unknown): string {
	return JSON.stringify(value, (_key, inner: unknown) =>
		inner instanceof Map
			? { map: [...inner] }
			: inner instanceof Set
				? { set: [...inner] }
				: inner,
	);
}

/** The draw as stored, so its batch is the wire's. */
function stored(draw: BlueprintDoc): BlueprintDoc {
	return hydratePersistedBlueprint(
		JSON.parse(JSON.stringify(toPersistableDoc(draw))),
	);
}

function replayed(doc: BlueprintDoc, batch: readonly Mutation[]): BlueprintDoc {
	return produce(doc, (draft) => {
		applyMutations(draft, admitMutationBatch(batch));
	});
}

/** The structural part's replay with the catalog run on top, held to the whole. */
function holdsCatalogTail(prev: BlueprintDoc, next: BlueprintDoc): boolean {
	const batch = diffDocsToMutations(prev, next);
	const at = batch.map((mutation) => CATALOG_KINDS.has(mutation.kind));
	const first = at.indexOf(true);
	if (first < 0) return false;
	const end = at.indexOf(false, first);
	const last = end < 0 ? batch.length : end;
	/* One run: no catalog mutation after the first non-catalog one past it. */
	expect(at.slice(last).includes(true)).toBe(false);
	const structural = batch.slice(0, first);
	const catalog = batch.slice(first, last);
	if (structural.length === 0) return false;
	expect(orderedJson(replayed(replayed(prev, structural), catalog))).toBe(
		orderedJson(replayed(prev, [...structural, ...catalog])),
	);
	return true;
}

const corpora = [
	["suite", suiteDocArbitrary],
	["menu screens", menuScreenDocArbitrary],
	["advanced menus", advancedDocArbitrary],
	["field trees", blueprintDocArbitrary],
] as const;

describe("a diff's catalog tail replayed on its structural part", () => {
	it.each(corpora)(
		"is the whole batch's replay for a %s document built from the empty one and from an earlier state",
		async (_name, arbitrary) => {
			let held = 0;
			await fc.assert(
				fc.property(arbitrary, fc.nat(), (draw, cut) => {
					const next = stored(draw);
					const empty = emptyBlueprintDoc(next.appId);
					if (holdsCatalogTail(empty, next)) held += 1;
					/* An earlier state of the same app: its construction batch cut
					 * short, so the diff to the whole one adds what the cut left. */
					const batch = diffDocsToMutations(empty, next);
					const earlier = replayed(
						empty,
						batch.slice(0, cut % (batch.length + 1)),
					);
					if (holdsCatalogTail(earlier, next)) held += 1;
				}),
				{ numRuns: 25, seed: 20261116 },
			);
			expect(held).toBeGreaterThan(0);
		},
		60_000,
	);
});

/**
 * The tail on top is the whole batch's replay only while `prev` holds no
 * translation: a batch prunes translations once, at its end. Here the
 * structural part converts the one question that types a case property as a
 * choice into a text question, so the property's choice has no translation
 * unit after it, and the catalog part declares the property a choice, which
 * gives the unit back. The one batch keeps the French translation of that
 * choice; the structural part replayed alone drops it, and a localization
 * diff over that replay would emit no removal of a translation `next` has
 * removed, so the batch would replay to a document still holding it.
 */
describe("a diff whose catalog tail gives back a translated choice", () => {
	const stage = casePropertyOptionTranslationUnitId("patient", "stage", "a");

	function patientApp(input: {
		readonly stageKind: "single_select" | "text";
		readonly declared: boolean;
		readonly translated: boolean;
	}): BlueprintDoc {
		const doc = buildDoc({
			appName: "Clinic",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{
							name: "stage",
							label: proseText("Stage"),
							...(input.declared ? { data_type: "single_select" } : {}),
							options: [{ value: "a", label: proseText("Early") }],
						},
					],
				},
			],
			modules: [
				{
					uuid: testUuid("replay-module"),
					name: "Patients",
					caseType: "patient",
					caseListConfig: {
						columns: [
							plainColumn(testUuid("replay-name-column"), "case_name", "Name"),
							plainColumn(testUuid("replay-stage-column"), "stage", "Stage"),
						],
						searchInputs: [],
					},
					forms: [
						{
							uuid: testUuid("replay-form"),
							name: "Register",
							type: "registration",
							fields: [
								{
									kind: "text",
									id: "name",
									uuid: testUuid("replay-name"),
									caseWrite: { caseType: "patient", property: "case_name" },
								},
								input.stageKind === "single_select"
									? {
											kind: "single_select",
											id: "stage",
											uuid: testUuid("replay-stage"),
											options: [
												{
													uuid: testUuid("replay-stage-a"),
													value: "a",
													label: "Early",
												},
											],
											caseWrite: { caseType: "patient", property: "stage" },
										}
									: {
											kind: "text",
											id: "stage",
											uuid: testUuid("replay-stage"),
											caseWrite: { caseType: "patient", property: "stage" },
										},
							],
						},
					],
				},
			],
		});
		const unit = translationUnitsById(doc).get(stage);
		if (unit === undefined)
			throw new Error("The fixture's choice has no translation unit.");
		doc.localization = {
			sourceLanguage: "eng",
			defaultLanguage: "eng",
			languageOrder: ["eng", "fra"],
			wireCodes: { eng: "en", fra: "fra" },
			translations: {
				fra: input.translated
					? {
							[stage]: {
								value: proseText("Précoce"),
								sourceFingerprint: unit.sourceFingerprint,
								origin: "human",
								review: "reviewed",
								translatedFrom: "eng",
							},
						}
					: {},
			},
		};
		return stored(doc);
	}

	it("replays to the target, the translation removed", () => {
		const prev = patientApp({
			stageKind: "single_select",
			declared: false,
			translated: true,
		});
		const next = patientApp({
			stageKind: "text",
			declared: true,
			translated: false,
		});
		const batch = diffDocsToMutations(prev, next);
		expect(batch.some((mutation) => CATALOG_KINDS.has(mutation.kind))).toBe(
			true,
		);
		expect(
			toPersistableDoc(replayed(prev, batch)).localization?.translations.fra,
		).toEqual({});
		expect(toPersistableDoc(replayed(prev, batch))).toEqual(
			toPersistableDoc(next),
		);
	});
});
