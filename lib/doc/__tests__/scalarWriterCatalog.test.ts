import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import { proseText } from "@/lib/domain/prose";
import { assertAdmittedDoc } from "./admittedDoc";

const FIELD = testUuid("scalar-writer");
function base(): BlueprintDoc {
	const doc = buildDoc({
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							{
								uuid: FIELD,
								kind: "text",
								id: "value",
								label: proseText("Value"),
							},
						],
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
	const verdict = mutationCommitVerdict(
		doc,
		mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok ? [] : verdict.findings).toEqual([]);
	return verdict.nextDoc;
}
function catalogNames(doc: BlueprintDoc): string[] {
	return doc.caseTypes?.[0]?.properties.map((property) => property.name) ?? [];
}

describe("scalar destinations and the authored property catalog", () => {
	it.each(["case_name", "external_id"])(
		"keeps writable scalar %s implicit through add, update and conversion",
		(property) => {
			const doc = base();
			const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
			const added = commit(doc, [
				{
					kind: "addField",
					parentUuid: formUuid,
					field: {
						uuid: testUuid("added-writer"),
						kind: "text",
						id: "writer",
						label: proseText("Writer"),
						caseWrite: { caseType: "patient", property },
					},
				},
			]);
			expect(catalogNames(added)).toEqual([]);
			const updated = commit(doc, [
				{
					kind: "updateField",
					uuid: FIELD,
					targetKind: "text",
					patch: { caseWrite: { caseType: "patient", property } },
				},
			]);
			expect(catalogNames(updated)).toEqual([]);
			const converted = commit(updated, [
				{ kind: "convertField", uuid: FIELD, toKind: "secret" },
			]);
			expect(converted.fields[FIELD]).toMatchObject({
				kind: "secret",
				caseWrite: { caseType: "patient", property },
			});
			expect(catalogNames(converted)).toEqual([]);
		},
	);
	it.each([
		"case_id",
		"case_type",
		"owner_id",
		"status",
		"date_opened",
		"last_modified",
	])("refuses ordinary writes to platform scalar %s", (property) => {
		const doc = base();
		const verdict = mutationCommitVerdict(
			doc,
			[
				{
					kind: "updateField",
					uuid: FIELD,
					targetKind: "text",
					patch: { caseWrite: { caseType: "patient", property } },
				},
			],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok).toBe(false);
		if (verdict.ok) throw new Error("Expected reserved destination refusal");
		expect(verdict.findings.map((finding) => finding.code)).toContain(
			"RESERVED_CASE_PROPERTY",
		);
		expect(catalogNames(doc)).toEqual([]);
	});
	it("registers a custom destination and preserves it after the writer is cleared", () => {
		const doc = commit(base(), [
			{
				kind: "updateField",
				uuid: FIELD,
				targetKind: "text",
				patch: {
					caseWrite: { caseType: "patient", property: "favorite_color" },
				},
			},
		]);
		expect(doc.caseTypes?.[0].properties).toEqual([
			{
				name: "favorite_color",
				label: proseText("favorite_color"),
				data_type: "text",
			},
		]);
		const cleared = commit(doc, [
			{
				kind: "updateField",
				uuid: FIELD,
				targetKind: "text",
				patch: { caseWrite: null },
			},
		]);
		expect(catalogNames(cleared)).toEqual(["favorite_color"]);
	});
});
