import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	LOOKUP_CONTEXT_UNAVAILABLE,
	type LookupValidationContext,
} from "@/lib/doc/lookupReferences";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import {
	hasMutationPrevalidation,
	registerMutationPrevalidation,
} from "@/lib/doc/mutationPrevalidation";
import type { Mutation } from "@/lib/doc/types";
import { proseText } from "@/lib/domain/prose";

function fixture() {
	const doc = buildDoc({
		appName: "Mutation proof",
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [
							f({
								kind: "text",
								id: "nickname",
								label: proseText("Nickname"),
							}),
						],
					},
				],
			},
		],
	});
	const field = Object.values(doc.fields)[0];
	const mutations: readonly Mutation[] = [
		{
			kind: "updateField",
			uuid: field.uuid,
			targetKind: "text",
			patch: { id: "preferred_name" },
		},
	];
	return { doc, mutations };
}

describe("mutation prevalidation", () => {
	it("matches only the exact document, lookup snapshot, and batch", () => {
		const { doc, mutations } = fixture();
		registerMutationPrevalidation(doc, LOOKUP_CONTEXT_UNAVAILABLE, mutations);
		expect(
			hasMutationPrevalidation(doc, LOOKUP_CONTEXT_UNAVAILABLE, mutations),
		).toBe(true);

		const changedDoc = { ...doc };
		const changedContext: LookupValidationContext = { kind: "unavailable" };
		expect(
			hasMutationPrevalidation(
				changedDoc,
				LOOKUP_CONTEXT_UNAVAILABLE,
				mutations,
			),
		).toBe(false);
		expect(hasMutationPrevalidation(doc, changedContext, mutations)).toBe(
			false,
		);
		expect(
			hasMutationPrevalidation(doc, LOOKUP_CONTEXT_UNAVAILABLE, [
				{ ...mutations[0], patch: { id: "other" } } as Mutation,
			]),
		).toBe(false);
	});

	it("does not let a proven mutation authorize a broader batch", () => {
		const { doc, mutations } = fixture();
		registerMutationPrevalidation(doc, LOOKUP_CONTEXT_UNAVAILABLE, mutations);
		expect(
			hasMutationPrevalidation(doc, LOOKUP_CONTEXT_UNAVAILABLE, [
				...mutations,
				{ kind: "setAppName", name: "Broader" },
			]),
		).toBe(false);
	});

	it("matches the same batch after admission canonicalizes object order", () => {
		const { doc, mutations } = fixture();
		registerMutationPrevalidation(doc, LOOKUP_CONTEXT_UNAVAILABLE, mutations);

		const admitted = admitMutationBatch(mutations);
		expect(admitted).toEqual(mutations);
		expect(JSON.stringify(admitted)).not.toBe(JSON.stringify(mutations));
		expect(
			hasMutationPrevalidation(doc, LOOKUP_CONTEXT_UNAVAILABLE, admitted),
		).toBe(true);
	});
});
