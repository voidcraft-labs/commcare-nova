/** Q4's field-list planner, through the real reducers and the commit gate. */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { planGroupFieldLists } from "@/lib/doc/groupFieldLists";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, Mutation, Uuid } from "@/lib/doc/types";
import {
	effectiveAppLocalization,
	makeTranslationUnitId,
} from "@/lib/domain/localization";
import { proseTemplateIsEmpty, proseText } from "@/lib/domain/prose";
import {
	localizeTranslationUnit,
	snapshotTranslationUnits,
} from "@/lib/domain/translationUnits";
import { assertAdmittedDoc } from "./admittedDoc";

const FLAT = testUuid("q4-flat-form");
const PAGED = testUuid("q4-paged-form");
const LABELLED = testUuid("q4-labelled");
const TRANSLATED = testUuid("q4-translated");
const DEEP = testUuid("q4-deep");
const DEEP_MIDDLE = testUuid("q4-deep-middle");
const DEEP_REPEAT = testUuid("q4-deep-repeat");
const UNLABELLED = testUuid("q4-unlabelled");
const BOUND_HOLDER = testUuid("q4-bound-holder");
const ALREADY = testUuid("q4-already");
const SECTION = testUuid("q4-section");
const ON_PAGE = testUuid("q4-on-page");

/** A label shows when some language's text for it is not blank, a
 *  translation included: the shape of the cutover's frozen predicate. */
function labelShowsInSomeLanguage(doc: BlueprintDoc, groupUuid: Uuid) {
	const unit = snapshotTranslationUnits(doc).get(
		makeTranslationUnitId("field", groupUuid, "label"),
	);
	if (unit === undefined) return false;
	return effectiveAppLocalization(doc.localization).languageOrder.some(
		(language) => {
			const value = localizeTranslationUnit(doc, language, unit).effective;
			return typeof value === "string"
				? value.length > 0
				: !proseTemplateIsEmpty(value);
		},
	);
}

function commit(doc: BlueprintDoc, mutations: Mutation[]): BlueprintDoc {
	const verdict = mutationCommitVerdict(
		doc,
		mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok ? [] : verdict.findings).toEqual([]);
	return verdict.nextDoc;
}

function fixture(): BlueprintDoc {
	const base = buildDoc({
		appName: "Field lists",
		modules: [
			{
				name: "M",
				forms: [
					{
						uuid: FLAT,
						name: "Visit",
						type: "survey",
						fields: [
							f({
								kind: "group",
								uuid: LABELLED,
								id: "household",
								label: proseText("Household"),
								children: [f({ kind: "text", id: "head" })],
							}),
							f({
								kind: "group",
								uuid: TRANSLATED,
								id: "translated",
								label: proseText(""),
								children: [f({ kind: "text", id: "only_spanish" })],
							}),
							f({
								kind: "group",
								uuid: DEEP,
								id: "deep",
								label: proseText("Visits"),
								children: [
									f({
										kind: "group",
										uuid: DEEP_MIDDLE,
										id: "middle",
										children: [
											f({
												kind: "repeat",
												uuid: DEEP_REPEAT,
												id: "entries",
												repeat_mode: "user_controlled",
												children: [f({ kind: "text", id: "entry" })],
											}),
										],
									}),
								],
							}),
							f({
								kind: "group",
								uuid: UNLABELLED,
								id: "wrapper",
								label: proseText(""),
								children: [f({ kind: "text", id: "loose" })],
							}),
							f({
								kind: "group",
								uuid: BOUND_HOLDER,
								id: "rounds_group",
								label: proseText("Rounds"),
								children: [
									f({
										kind: "repeat",
										id: "rounds",
										repeat_mode: "count_bound",
										repeat_count: "2",
										children: [f({ kind: "text", id: "round" })],
									}),
								],
							}),
							f({
								kind: "group",
								uuid: ALREADY,
								id: "already",
								label: proseText("Already"),
								fieldList: true,
								children: [f({ kind: "text", id: "kept" })],
							}),
						],
					},
					{
						uuid: PAGED,
						name: "Paged",
						type: "survey",
						fields: [
							f({
								kind: "section",
								uuid: SECTION,
								id: "page",
								label: proseText("Page"),
								children: [
									f({
										kind: "group",
										uuid: ON_PAGE,
										id: "on_page",
										label: proseText("On the page"),
										children: [f({ kind: "text", id: "paged" })],
									}),
								],
							}),
						],
					},
				],
			},
		],
	});
	assertAdmittedDoc(base);
	const unit = snapshotTranslationUnits(base).get(
		makeTranslationUnitId("field", TRANSLATED, "label"),
	);
	if (unit === undefined)
		throw new Error("The blank label must still be a translation unit.");
	return commit(base, [
		{ kind: "addLanguage", language: { language: "spa" }, wireCode: "es" },
		{
			kind: "setTranslation",
			language: "spa",
			unitId: unit.id,
			entry: {
				value: proseText("Solo en español"),
				sourceFingerprint: unit.sourceFingerprint,
				origin: "human",
				review: "reviewed",
				translatedFrom: "eng",
			},
		},
	]);
}

describe("planGroupFieldLists", () => {
	it("sets the flag on each shown group with no add-entries repeat, in document order, and the gate admits it", () => {
		const doc = fixture();
		const plan = planGroupFieldLists(doc, labelShowsInSomeLanguage);
		expect(plan).toEqual(
			[LABELLED, TRANSLATED, BOUND_HOLDER, ON_PAGE].map((uuid) => ({
				kind: "updateField",
				uuid,
				targetKind: "group",
				patch: { fieldList: true },
			})),
		);
		const next = commit(doc, plan);
		for (const uuid of [LABELLED, TRANSLATED, BOUND_HOLDER, ON_PAGE, ALREADY])
			expect(next.fields[uuid]).toMatchObject({ fieldList: true });
		// A group holding a user repeat two levels down, the group between
		// them, an unlabelled group and the section are left as they were.
		for (const uuid of [DEEP, DEEP_MIDDLE, UNLABELLED, SECTION])
			expect(next.fields[uuid]).toEqual(doc.fields[uuid]);
	});

	it("reads the label only through the predicate it is given", () => {
		const doc = fixture();
		const sourceOnly = (d: BlueprintDoc, uuid: Uuid) => {
			const field = d.fields[uuid];
			return (
				field !== undefined &&
				"label" in field &&
				!proseTemplateIsEmpty(field.label)
			);
		};
		expect(
			planGroupFieldLists(doc, sourceOnly).map((m) =>
				m.kind === "updateField" ? m.uuid : undefined,
			),
		).toEqual([LABELLED, BOUND_HOLDER, ON_PAGE]);
	});

	it("plans nothing on a second run", () => {
		const doc = fixture();
		const next = commit(
			doc,
			planGroupFieldLists(doc, labelShowsInSomeLanguage),
		);
		expect(planGroupFieldLists(next, labelShowsInSomeLanguage)).toEqual([]);
	});
});
