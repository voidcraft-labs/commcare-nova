import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { planFieldCaseWrite } from "@/lib/doc/fieldCaseWriteMutations";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import { fieldCaseWriteViews, type Uuid } from "@/lib/domain";
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

/** The batch the one "Saves to" planner gives FIELD for `property`. */
function saveTo(
	doc: BlueprintDoc,
	fieldUuid: Uuid,
	property: string | null,
): readonly Mutation[] {
	const plan = planFieldCaseWrite(
		doc,
		fieldUuid,
		property === null ? null : { caseType: "patient", property },
	);
	if (!plan.ok) throw new Error(plan.message);
	return plan.mutations;
}
function savesTo(doc: BlueprintDoc, fieldUuid: Uuid) {
	return fieldCaseWriteViews(doc, fieldUuid).map((view) => ({
		caseType: view.caseType,
		property: view.property,
	}));
}

describe("scalar destinations and the authored property catalog", () => {
	it.each(["case_name", "external_id"])(
		"keeps writable scalar %s implicit through add, update and conversion",
		(property) => {
			const doc = base();
			const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
			const writer = testUuid("added-writer");
			const born = commit(doc, [
				{
					kind: "addField",
					parentUuid: formUuid,
					field: {
						uuid: writer,
						kind: "text",
						id: "writer",
						label: proseText("Writer"),
					},
				},
			]);
			const added = commit(born, saveTo(born, writer, property));
			expect(savesTo(added, writer)).toEqual([
				{ caseType: "patient", property },
			]);
			expect(catalogNames(added)).toEqual([]);
			const updated = commit(doc, saveTo(doc, FIELD, property));
			expect(catalogNames(updated)).toEqual([]);
			const converted = commit(updated, [
				{ kind: "convertField", uuid: FIELD, toKind: "secret" },
			]);
			expect(converted.fields[FIELD]).toMatchObject({ kind: "secret" });
			expect(savesTo(converted, FIELD)).toEqual([
				{ caseType: "patient", property },
			]);
			expect(catalogNames(converted)).toEqual([]);
		},
	);
	it.each(["case_id", "case_type", "status", "date_opened", "last_modified"])(
		"refuses ordinary writes to platform scalar %s",
		(property) => {
			const doc = base();
			const verdict = mutationCommitVerdict(
				doc,
				saveTo(doc, FIELD, property),
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			expect(verdict.ok).toBe(false);
			if (verdict.ok) throw new Error("Expected reserved destination refusal");
			expect(verdict.findings.map((finding) => finding.code)).toContain(
				"CASE_OPERATION_RESERVED_PROPERTY",
			);
			expect(catalogNames(doc)).toEqual([]);
		},
	);
	it("saves an answer to owner_id as the case's owner", () => {
		const doc = base();
		const owned = commit(doc, saveTo(doc, FIELD, "owner_id"));
		const own = owned.forms[
			owned.formOrder[owned.moduleOrder[0]][0]
		]?.caseOperations?.find((operation) => operation.action === "own");
		expect(own?.owner).toEqual({
			kind: "term",
			term: { kind: "field", uuid: FIELD },
		});
		expect(own?.writes ?? []).toEqual([]);
		expect(catalogNames(owned)).toEqual([]);
	});
	it("registers a custom destination and preserves it after the writer is cleared", () => {
		const start = base();
		const doc = commit(start, saveTo(start, FIELD, "favorite_color"));
		// The new entry takes the text question's type.
		expect(doc.caseTypes?.[0].properties).toEqual([
			{
				name: "favorite_color",
				label: proseText("Favorite color"),
				data_type: "text",
			},
		]);
		const cleared = commit(doc, saveTo(doc, FIELD, null));
		expect(savesTo(cleared, FIELD)).toEqual([]);
		expect(catalogNames(cleared)).toEqual(["favorite_color"]);
	});
});
