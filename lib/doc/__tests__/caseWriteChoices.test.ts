import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	type CaseWriteChoiceVerdict,
	caseWriteChoiceVerdict,
} from "@/lib/doc/caseWriteChoices";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	type Field,
	fieldCaseWriteViewKey,
	fieldCaseWriteViews,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { assertAdmittedDoc } from "./admittedDoc";

function fixture(): { doc: BlueprintDoc; name: Field; notes: Field } {
	const doc = buildDoc({
		appName: "Case write choices",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{
						name: "case_name",
						label: proseText("Name"),
						data_type: "text",
					},
					{
						name: "notes",
						label: proseText("Notes"),
						data_type: "text",
					},
					{
						name: "nickname",
						label: proseText("Nickname"),
						data_type: "text",
					},
					{
						name: "dob",
						label: proseText("Date of birth"),
						data_type: "date",
					},
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Register patient",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "first_name",
								label: proseText("Name"),
								caseWrite: {
									caseType: "patient",
									property: "case_name",
								},
							}),
							f({
								kind: "text",
								id: "visit_notes",
								label: proseText("Notes"),
								caseWrite: {
									caseType: "patient",
									property: "notes",
								},
							}),
						],
					},
				],
			},
		],
	});
	assertAdmittedDoc(doc);
	const moduleUuid = doc.moduleOrder[0];
	const formUuid = doc.formOrder[moduleUuid][0];
	const [nameUuid, notesUuid] = doc.fieldOrder[formUuid];
	return {
		doc,
		name: doc.fields[nameUuid],
		notes: doc.fields[notesUuid],
	};
}

/** Commit an admitted verdict's batch through the gate it was judged by. */
function commit(
	doc: BlueprintDoc,
	verdict: CaseWriteChoiceVerdict,
): BlueprintDoc {
	if (!verdict.ok) throw new Error(verdict.reason);
	const committed = mutationCommitVerdict(
		doc,
		verdict.mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(committed.ok ? [] : committed.findings).toEqual([]);
	return committed.nextDoc;
}

const propertiesOf = (doc: BlueprintDoc, field: Field) =>
	fieldCaseWriteViews(doc, field.uuid).map((view) => view.property);

describe("caseWriteChoiceVerdict", () => {
	it("admits a declared property no question saves yet, replacing the question's save", () => {
		const { doc, notes } = fixture();
		const verdict = caseWriteChoiceVerdict(
			doc,
			notes.uuid,
			{ destination: { caseType: "patient", property: "nickname" } },
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict).toMatchObject({ ok: true, notes: [] });
		expect(propertiesOf(commit(doc, verdict), notes)).toEqual(["nickname"]);
	});

	it("admits a new property, declaring it in the same batch", () => {
		const { doc, notes } = fixture();
		const verdict = caseWriteChoiceVerdict(
			doc,
			notes.uuid,
			{ destination: { caseType: "patient", property: "preferred_language" } },
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		const next = commit(doc, verdict);
		expect(propertiesOf(next, notes)).toEqual(["preferred_language"]);
		expect(
			next.caseTypes
				?.find((caseType) => caseType.name === "patient")
				?.properties.some((property) => property.name === "preferred_language"),
		).toBe(true);
	});

	it("stops every save of a question, and refuses stopping the new case's only name", () => {
		const { doc, name, notes } = fixture();
		const stopped = caseWriteChoiceVerdict(
			doc,
			notes.uuid,
			{ destination: null },
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(propertiesOf(commit(doc, stopped), notes)).toEqual([]);

		expect(
			caseWriteChoiceVerdict(
				doc,
				name.uuid,
				{ destination: null },
				LOOKUP_CONTEXT_UNAVAILABLE,
			),
		).toEqual({
			ok: false,
			reason:
				"A new case needs a name. Choose another question to name it first.",
		});
	});

	it("replaces only the row a choice names", () => {
		const { doc, notes } = fixture();
		const both = commit(
			doc,
			caseWriteChoiceVerdict(
				doc,
				notes.uuid,
				{ destination: { caseType: "patient", property: "nickname" } },
				LOOKUP_CONTEXT_UNAVAILABLE,
			),
		);
		const [row] = fieldCaseWriteViews(both, notes.uuid);
		const verdict = caseWriteChoiceVerdict(
			both,
			notes.uuid,
			{
				destination: { caseType: "patient", property: "notes" },
				replace: fieldCaseWriteViewKey(row),
			},
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(propertiesOf(commit(both, verdict), notes)).toEqual(["notes"]);
	});

	it("disables a property whose declared type the answer doesn't match, in the gate's sentence", () => {
		const { doc, notes } = fixture();
		const mismatch = caseWriteChoiceVerdict(
			doc,
			notes.uuid,
			{ destination: { caseType: "patient", property: "dob" } },
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(mismatch.ok).toBe(false);
		if (!mismatch.ok) {
			expect(mismatch.reason).toMatch(
				/date|data type|shape|type doesn't match/i,
			);
		}
	});
});
