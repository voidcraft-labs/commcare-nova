import { expect, it } from "vitest";
import { caseChoiceDoc, choiceUuid } from "@/lib/__tests__/caseChoiceFixture";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	type CaseOptionsSource,
	casePropertyTargetKey,
	caseTypeTargetKey,
} from "@/lib/domain";
import { eq, formField, prop, term, walkTerms } from "@/lib/domain/predicate";
import { planCaseTypeRetirementOnRemove } from "../caseTypeRetirement";
import { mutationCommitVerdict } from "../commitVerdicts";
import { diffDocsToMutations } from "../diffDocsToMutations";
import { duplicateFieldMutations } from "../duplicateFieldMutations";
import { toPersistableDoc } from "../fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "../lookupReferences";
import {
	buildReferenceIndex,
	referencingCarrierUuids,
} from "../referenceIndex";
import { createBlueprintDocStore } from "../store";
import { type Mutation, mutationSchema } from "../types";
import { assertAdmittedDoc } from "./admittedDoc";

function apply(doc: BlueprintDoc, mutations: Mutation[]) {
	const verdict = mutationCommitVerdict(
		doc,
		mutations.map((m) => mutationSchema.parse(JSON.parse(JSON.stringify(m)))),
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok ? [] : verdict.findings).toEqual([]);
	return verdict.nextDoc;
}

it("admits valid source replacements through replay and undo, and refuses dangling or out-of-scope sources", () => {
	const doc = caseChoiceDoc();
	assertAdmittedDoc(doc);
	const fieldUuid = choiceUuid("members");
	const replace = (source: CaseOptionsSource): Mutation => ({
		kind: "updateField",
		uuid: fieldUuid,
		targetKind: "multi_select",
		patch: { optionsSource: source },
	});
	const source: CaseOptionsSource = {
		kind: "cases",
		caseType: "clinic",
		labelProperty: "region",
		filter: eq(prop("clinic", "region"), formField(choiceUuid("clinic"))),
	};
	const mutation = replace(source);
	const next = apply(doc, [mutation]);
	const replayed = apply(doc, diffDocsToMutations(doc, next));
	expect(toPersistableDoc(replayed)).toEqual(toPersistableDoc(next));
	const store = createBlueprintDocStore();
	store.getState().load(toPersistableDoc(doc));
	store.getState().startTracking();
	store.getState().applyMany([mutation]);
	expect(store.getState().fields[fieldUuid]).toEqual(next.fields[fieldUuid]);
	store.getState().undo();
	expect(store.getState().fields[fieldUuid]).toEqual(doc.fields[fieldUuid]);
	for (const invalid of [
		{ ...source, caseType: "missing" },
		{ ...source, labelProperty: "missing" },
		{
			...source,
			filter: eq(prop("clinic", "region"), formField(choiceUuid("selected"))),
		},
		{
			...source,
			filter: eq(
				prop("clinic", "region"),
				term({ kind: "form-case", caseType: "clinic", property: "region" }),
			),
		},
	])
		expect(
			mutationCommitVerdict(doc, [replace(invalid)], LOOKUP_CONTEXT_UNAVAILABLE)
				.ok,
		).toBe(false);
});

it("renames label, candidate and selected properties together and blocks deleting referenced definitions", () => {
	const base = caseChoiceDoc();
	const fieldUuid = choiceUuid("attendees");
	const doc = apply(base, [
		{
			kind: "updateField",
			uuid: fieldUuid,
			targetKind: "multi_select",
			patch: {
				optionsSource: {
					kind: "cases",
					caseType: "clinic",
					labelProperty: "region",
					filter: eq(
						prop("clinic", "region"),
						term({ kind: "form-case", caseType: "clinic", property: "region" }),
					),
				},
			},
		},
	]);
	expect(
		referencingCarrierUuids(doc, casePropertyTargetKey("clinic", "region")),
	).toContain(fieldUuid);
	expect(referencingCarrierUuids(doc, caseTypeTargetKey("clinic"))).toContain(
		fieldUuid,
	);
	const renamed = apply(doc, [
		{
			kind: "renameCaseProperties",
			renames: [{ caseType: "clinic", from: "region", to: "district" }],
		},
	]);
	expect(renamed.fields[fieldUuid]).toMatchObject({
		optionsSource: {
			labelProperty: "district",
			filter: eq(
				prop("clinic", "district"),
				term({ kind: "form-case", caseType: "clinic", property: "district" }),
			),
		},
	});
	expect(renamed.refIndex).toEqual(buildReferenceIndex(renamed));
	expect(
		referencingCarrierUuids(renamed, casePropertyTargetKey("clinic", "region")),
	).toEqual([]);
	expect(
		planCaseTypeRetirementOnRemove(renamed, choiceUuid("attendance-module"))
			.kind,
	).toBe("blocked");
	expect(
		mutationCommitVerdict(
			renamed,
			[{ kind: "retireCaseType", caseType: "clinic" }],
			LOOKUP_CONTEXT_UNAVAILABLE,
		).ok,
	).toBe(false);
});

it("duplicates a repeated dependent choice with references to its own cloned answers and rejects sibling-repeat reads", () => {
	const group = choiceUuid("repeated");
	const region = choiceUuid("region");
	const clinic = choiceUuid("repeat-clinic");
	const doc = buildDoc({
		caseTypes: [
			{
				name: "clinic",
				properties: [{ name: "region", label: "Region", data_type: "text" }],
			},
		],
		modules: [
			{
				name: "Directory",
				forms: [
					{
						name: "Directory",
						type: "survey",
						fields: [
							f({
								uuid: group,
								id: "visits",
								kind: "repeat",
								label: "Visits",
								children: [
									f({
										uuid: region,
										id: "region",
										kind: "text",
										label: "Region",
									}),
									f({
										uuid: clinic,
										id: "clinic",
										kind: "single_select",
										label: "Clinic",
										optionsSource: {
											kind: "cases",
											caseType: "clinic",
											labelProperty: "case_name",
											filter: eq(prop("clinic", "region"), formField(region)),
										},
									}),
								],
							}),
						],
					},
				],
			},
		],
	});
	assertAdmittedDoc(doc);
	const plan = duplicateFieldMutations(doc, group);
	if (!plan) throw new Error("Expected a duplicate");
	const cloned = apply(doc, plan.mutations);
	const [regionClone, clinicClone] = cloned.fieldOrder[plan.cloneUuid];
	const source = cloned.fields[clinicClone];
	if (
		source.kind !== "single_select" ||
		source.optionsSource.kind !== "cases" ||
		!source.optionsSource.filter
	)
		throw new Error("Expected cloned choices");
	const references: string[] = [];
	walkTerms(source.optionsSource.filter, (t) => {
		if (t.kind === "field") references.push(t.uuid);
	});
	expect(references).toEqual([regionClone]);
	const invalid: Mutation = {
		kind: "updateField",
		uuid: clinicClone,
		targetKind: "single_select",
		patch: {
			optionsSource: {
				...source.optionsSource,
				filter: eq(prop("clinic", "region"), formField(region)),
			},
		},
	};
	expect(
		mutationCommitVerdict(cloned, [invalid], LOOKUP_CONTEXT_UNAVAILABLE).ok,
	).toBe(false);
	expect(cloned.refIndex).toEqual(buildReferenceIndex(cloned));
});
