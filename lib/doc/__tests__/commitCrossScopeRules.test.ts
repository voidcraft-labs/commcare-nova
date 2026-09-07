import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { type Mutation, mutationSchema } from "@/lib/doc/types";
import type { BlueprintDoc, Field } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { assertAdmittedDoc } from "./admittedDoc";

/** Field lookup by semantic id (unique across these fixtures). */
function byId(doc: BlueprintDoc, id: string): Field {
	const field = Object.values(doc.fields).find((fl) => fl.id === id);
	if (!field) throw new Error(`fixture missing field "${id}"`);
	return field;
}

function formUuidAt(doc: BlueprintDoc, m: number, fIdx: number) {
	return doc.formOrder[doc.moduleOrder[m]][fIdx];
}

/**
 * The rich base fixture most probes share. Module 0 ("Patients",
 * patient): a registration form (case_name / village / dob writers) and
 * a followup form (a second `dob` writer — cousins legally share the id
 * — plus a `workflow_status` writer and an empty repeat). Module 1 ("Archive",
 * case-less): a survey whose form link targets the registration form.
 * Valid in full (no completeness findings), so every probe's rejection
 * is a finding the PROBE introduced.
 */
function richDoc(): BlueprintDoc {
	const doc = buildDoc({
		appName: "Guard Coverage",
		modules: [
			{
				name: "Patients",
				uuid: "mod-patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Register",
						type: "registration",
						uuid: "frm-reg",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: proseText("Name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							f({
								kind: "text",
								id: "village",
								label: proseText("Village"),
								caseWrite: { caseType: "patient", property: "village" },
							}),
							f({
								kind: "date",
								id: "dob",
								label: proseText("Date of birth"),
								caseWrite: { caseType: "patient", property: "dob" },
							}),
						],
					},
					{
						name: "Follow up",
						type: "followup",
						fields: [
							f({
								kind: "date",
								id: "dob",
								label: proseText("Date of birth"),
								caseWrite: { caseType: "patient", property: "dob" },
							}),
							f({
								kind: "text",
								id: "workflow_status",
								label: proseText("Status"),
								caseWrite: {
									caseType: "patient",
									property: "workflow_status",
								},
							}),
							f({
								kind: "repeat",
								id: "visits",
								label: proseText("Visits"),
								children: [
									f({ kind: "text", id: "note", label: proseText("Note") }),
								],
							}),
						],
					},
				],
			},
			{
				name: "Archive",
				forms: [
					{
						name: "Archive survey",
						type: "survey",
						fields: [
							f({ kind: "text", id: "comments", label: proseText("Comments") }),
						],
						// A conditional link followed by its exhaustive "otherwise":
						// the baseline is valid with no explicit postSubmit, and each
						// link kind's probe below breaks exactly one rule of it.
						formLinks: [
							{
								uuid: "lnk-cond",
								condition: "1 = 1",
								target: {
									type: "form",
									moduleUuid: testUuid("mod-patients"),
									formUuid: testUuid("frm-reg"),
								},
							},
							{
								uuid: "lnk-else",
								target: {
									type: "module",
									moduleUuid: testUuid("mod-patients"),
								},
							},
						],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "village", label: proseText("Village") },
					{ name: "dob", label: proseText("Date of birth") },
					{ name: "workflow_status", label: proseText("Status") },
				],
			},
		],
	});
	assertAdmittedDoc(doc);
	return doc;
}

function commit(doc: BlueprintDoc, mutations: readonly Mutation[]) {
	assertAdmittedDoc(doc);
	const before = structuredClone(doc);
	const result = mutationCommitVerdict(
		doc,
		mutations.map((mutation) =>
			mutationSchema.parse(JSON.parse(JSON.stringify(mutation))),
		),
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(doc).toEqual(before);
	return result;
}
function codes(result: ReturnType<typeof commit>) {
	if (result.ok) throw new Error("expected refusal");
	return result.findings.map((finding) => finding.code);
}

describe("commit dependencies beyond the edited field or form", () => {
	it("refuses removing a registration name writer but permits transferring its role atomically", () => {
		const doc = richDoc();
		const name = byId(doc, "case_name"),
			replacement = byId(doc, "village");
		expect(
			codes(commit(doc, [{ kind: "removeField", uuid: name.uuid }])),
		).toContain("CASE_CREATE_NAME_MISSING");
		const result = commit(doc, [
			{ kind: "removeField", uuid: name.uuid },
			{
				kind: "updateField",
				uuid: replacement.uuid,
				targetKind: "text",
				patch: { caseWrite: { caseType: "patient", property: "case_name" } },
			},
		]);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("atomic name transfer must commit");
		expect(result.nextDoc.fields[name.uuid]).toBeUndefined();
		expect(result.nextDoc.fields[replacement.uuid]).toMatchObject({
			caseWrite: { caseType: "patient", property: "case_name" },
		});
	});
	it("refuses a type conversion that disagrees with another form's writer", () => {
		const doc = richDoc();
		const uuid = doc.fieldOrder[formUuidAt(doc, 0, 1)].find(
			(uuid) => doc.fields[uuid].id === "dob",
		);
		if (!uuid) throw new Error("missing date writer");
		expect(
			codes(commit(doc, [{ kind: "convertField", uuid, toKind: "time" }])),
		).toContain("FIELD_KIND_WRITERS_DISAGREE");
	});
	it("refuses moving a primary case writer into a repeat", () => {
		const doc = richDoc();
		expect(
			codes(
				commit(doc, [
					{
						kind: "moveField",
						uuid: byId(doc, "workflow_status").uuid,
						toParentUuid: byId(doc, "visits").uuid,
						after: null,
					},
				]),
			),
		).toContain("PRIMARY_CASE_FIELD_IN_REPEAT");
	});
	it("refuses turning a case-free survey into a registration form", () => {
		const doc = richDoc();
		expect(
			codes(
				commit(doc, [
					{
						kind: "updateForm",
						uuid: formUuidAt(doc, 1, 0),
						patch: { type: "registration" },
					},
				]),
			),
		).toContain("NO_CASE_TYPE");
	});
	it("refuses activating Connect before any form participates", () => {
		expect(
			codes(
				commit(richDoc(), [{ kind: "setConnectType", connectType: "learn" }]),
			),
		).toContain("CONNECT_NO_PARTICIPATING_FORMS");
	});
});
