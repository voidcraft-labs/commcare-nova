import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import type {
	BlueprintDoc,
	CaseOperation,
	LookupColumnId,
	LookupTableId,
	Uuid,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { parseLookupRevision } from "@/lib/lookup/schema";
import { assertAdmittedPreviewDoc } from "@/lib/preview/__tests__/fixtures/admittedDoc";
import type { SubmissionMutation } from "../../caseDataBindingTypes";
import { FormEngine, type FormEngineInput } from "../../formEngine";

const ENTRY_KEY = "11111111-1111-4111-8111-111111111111";
const LOOKUP_CONTEXT: LookupValidationContext = {
	kind: "available",
	projectId: "project-acceptance",
	projectRevision: parseLookupRevision("1"),
	definitions: [
		{
			id: "70000000-0000-7000-8000-000000000001" as LookupTableId,
			name: "Status",
			tag: "status",
			definitionRevision: parseLookupRevision("1"),
			columns: [
				{
					id: "70000000-0000-7000-8000-000000000002" as LookupColumnId,
					wireName: "status",
					label: "Status",
					dataType: "text",
				},
			],
		},
	],
};
/** One followup doc: an external-id writer (ordinary), a free root answer, and
 *  a repeat of visit notes — with `operations` built from the minted
 *  field uuids per test. */
export function acceptanceDoc(
	operationsFor: (uuids: {
		externalCode: Uuid;
		note: Uuid;
		extra: Uuid;
		visits: Uuid;
		visitNote: Uuid;
	}) => CaseOperation[],
): {
	doc: BlueprintDoc;
	formUuid: Uuid;
	uuids: {
		externalCode: Uuid;
		note: Uuid;
		extra: Uuid;
		visits: Uuid;
		visitNote: Uuid;
	};
} {
	const doc = buildDoc({
		appName: "Acceptance",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{
						name: "op_status",
						label: proseText("Op status"),
						data_type: "text",
					},
					{
						name: "visit_note",
						label: proseText("Visit note"),
						data_type: "text",
					},
				],
			},
		],
		modules: [
			{
				uuid: "60000000-0000-4000-8000-00000000a010",
				name: "Mod",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "60000000-0000-4000-8000-00000000a011",
						name: "Follow up",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "external_code",
								label: proseText("External code"),
								caseWrite: {
									caseType: "patient",
									property: "external_id",
								},
							}),
							f({ kind: "text", id: "note", label: proseText("Note") }),
							f({ kind: "text", id: "extra", label: proseText("Extra") }),
							f({
								kind: "repeat",
								id: "visits",
								label: proseText("Visits"),
								children: [
									f({
										kind: "text",
										id: "visit_note",
										label: proseText("Visit note"),
									}),
								],
							}),
						],
					},
				],
			},
		],
	});
	const formUuid = Object.keys(doc.forms)[0] as Uuid;
	const byId = new Map(
		Object.values(doc.fields).map((field) => [field.id, field.uuid]),
	);
	const uuids = {
		externalCode: byId.get("external_code") as Uuid,
		note: byId.get("note") as Uuid,
		extra: byId.get("extra") as Uuid,
		visits: byId.get("visits") as Uuid,
		visitNote: byId.get("visit_note") as Uuid,
	};
	const form = doc.forms[formUuid];
	return {
		doc: {
			...doc,
			forms: {
				...doc.forms,
				[formUuid]: { ...form, caseOperations: operationsFor(uuids) },
			},
		},
		formUuid,
		uuids,
	};
}

export function conditionalCloseDoc(): {
	doc: BlueprintDoc;
	formUuid: Uuid;
	conditionFieldUuid: Uuid;
} {
	const baseList = caseListConfig([{ field: "case_name", header: "Name" }]);
	const doc = buildDoc({
		appName: "Conditional batch close",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				uuid: "60000000-0000-4000-8000-00000000a020",
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					...baseList,
					selection: { kind: "multiple", maximum: 4 },
				},
				forms: [
					{
						uuid: "60000000-0000-4000-8000-00000000a021",
						name: "Close patients",
						type: "close",
						closeCondition: { field: "close_when", answer: "done" },
						fields: [
							f({
								kind: "text",
								id: "close_when",
								label: proseText("Close when"),
							}),
						],
					},
				],
			},
		],
	});
	const formUuid = Object.keys(doc.forms)[0] as Uuid;
	const conditionFieldUuid = Object.values(doc.fields).find(
		(field) => field.id === "close_when",
	)?.uuid;
	if (conditionFieldUuid === undefined) {
		throw new Error("Conditional-close fixture is missing close_when.");
	}
	return { doc, formUuid, conditionFieldUuid };
}

export function ordinaryAuthorityDoc(): {
	doc: BlueprintDoc;
	formUuid: Uuid;
} {
	const doc = buildDoc({
		appName: "Ordinary write authority",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "age", label: proseText("Age"), data_type: "int" },
					{ name: "nickname", label: proseText("Nickname") },
				],
			},
			{
				name: "visit",
				parent_type: "patient",
				properties: [
					{ name: "notes", label: proseText("Notes") },
					{ name: "private_note", label: proseText("Private note") },
				],
			},
			{
				name: "medication_order",
				parent_type: "patient",
				properties: [],
			},
			{
				name: "lab_result",
				parent_type: "patient",
				properties: [],
			},
		],
		modules: [
			...["visit", "medication_order", "lab_result"].map((caseType) => ({
				name: caseType,
				caseType,
				caseListOnly: true,
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [],
			})),
			{
				uuid: "60000000-0000-4000-8000-00000000a030",
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "60000000-0000-4000-8000-00000000a031",
						name: "Register patient",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "patient_name",
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							f({
								kind: "int",
								id: "age",
								caseWrite: { caseType: "patient", property: "age" },
							}),
							f({
								kind: "text",
								id: "visit_name",
								caseWrite: { caseType: "visit", property: "case_name" },
							}),
							f({
								kind: "text",
								id: "visit_notes",
								caseWrite: { caseType: "visit", property: "notes" },
							}),
							f({
								kind: "repeat",
								id: "orders",
								children: [
									f({
										kind: "text",
										id: "medication_name",
										caseWrite: {
											caseType: "medication_order",
											property: "case_name",
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
	return { doc, formUuid: Object.keys(doc.forms)[0] as Uuid };
}

export function ordinaryAuthorityMutation(
	doc: BlueprintDoc,
	formUuid: Uuid,
): Extract<SubmissionMutation, { kind: "registration" }> {
	const engine = engineFor(doc, formUuid);
	engine.setValue("/data/patient_name", "Ada");
	engine.setValue("/data/age", "37");
	engine.setValue("/data/visit_name", "First visit");
	engine.setValue("/data/visit_notes", "Checkup");
	engine.setValue("/data/orders[0]/medication_name", "Hydrangea");
	engine.addRepeat("/data/orders");
	engine.setValue("/data/orders[1]/medication_name", "Aspirin");
	const mutation = engine.computeSubmissionMutation({ entryKey: ENTRY_KEY });
	if (mutation.kind !== "registration") {
		throw new Error("Ordinary-authority fixture did not produce registration.");
	}
	return mutation;
}

export function engineFor(doc: BlueprintDoc, formUuid: Uuid): FormEngine {
	assertAdmittedPreviewDoc(doc, LOOKUP_CONTEXT);
	const input: FormEngineInput = {
		form: doc.forms[formUuid],
		formUuid,
		fields: doc.fields,
		fieldOrder: doc.fieldOrder,
		caseTypes: doc.caseTypes ?? [],
	};
	return new FormEngine(input, "patient", undefined, null);
}
