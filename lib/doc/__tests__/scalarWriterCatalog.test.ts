import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { applyMutations } from "@/lib/doc/mutations";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import { CASE_SCALAR_PROPERTY_NAMES, type Field } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

const FIELD = testUuid("11111111-1111-4111-8111-111111111111");

function base(fieldProperty?: string): BlueprintDoc {
	return buildDoc({
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						name: "Register",
						type: "registration",
						fields:
							fieldProperty === undefined
								? []
								: [
										f({
											uuid: FIELD,
											kind: "text",
											id: "value",
											label: proseText("Value"),
											caseWrite: {
												caseType: "patient",
												property: fieldProperty,
											},
										}),
									],
					},
				],
			},
		],
	});
}

function reduce(
	doc: BlueprintDoc,
	mutations: readonly Mutation[],
): BlueprintDoc {
	return produce(doc, (draft) => {
		applyMutations(draft, mutations);
	});
}

function catalogNames(doc: BlueprintDoc): string[] {
	return doc.caseTypes?.[0]?.properties.map(({ name }) => name) ?? [];
}

describe("case scalar field writers never synthesize catalog properties", () => {
	it("covers every scalar name through add, update, and convert reducers", () => {
		for (const property of CASE_SCALAR_PROPERTY_NAMES) {
			const addBase = base();
			const formUuid = addBase.formOrder[addBase.moduleOrder[0]][0];
			const added = reduce(addBase, [
				{
					kind: "addField",
					parentUuid: formUuid,
					field: f({
						uuid: FIELD,
						kind: "text",
						id: "value",
						label: proseText("Value"),
						caseWrite: { caseType: "patient", property },
					}) as Field,
				},
			]);
			expect(catalogNames(added), `addField ${property}`).toEqual([]);

			const updateBase = base();
			const updateFormUuid = updateBase.formOrder[updateBase.moduleOrder[0]][0];
			const updated = reduce(updateBase, [
				{
					kind: "addField",
					parentUuid: updateFormUuid,
					field: f({
						uuid: FIELD,
						kind: "text",
						id: "value",
						label: proseText("Value"),
					}) as Field,
				},
				{
					kind: "updateField",
					uuid: FIELD,
					targetKind: "text",
					patch: { caseWrite: { caseType: "patient", property } },
				},
			]);
			expect(catalogNames(updated), `updateField ${property}`).toEqual([]);

			const converted = reduce(base(property), [
				{ kind: "convertField", uuid: FIELD, toKind: "secret" },
			]);
			expect(catalogNames(converted), `convertField ${property}`).toEqual([]);
		}
	});
});
