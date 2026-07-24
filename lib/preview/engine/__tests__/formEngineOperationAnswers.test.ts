// The per-scope operation answer collector: complete-per-iteration
// lists (root + enclosing concrete instances + own), parent-major
// flattening, multi-select token arrays, and the operation-free
// undefined — the client half of the S07b program-builder contract.

import { describe, expect, it } from "vitest";
import type {
	CaseOperation,
	Field,
	FieldKind,
	Form,
	FormType,
	Uuid,
} from "@/lib/domain";
import { asUuid } from "@/lib/domain";
import { FormEngine, type FormEngineInput } from "../formEngine";

interface DField {
	id: string;
	kind: FieldKind;
	label?: string;
	options?: Array<{ value: string; label: string }>;
	children?: DField[];
}

function dTree(
	fields: DField[],
	caseOperations?: CaseOperation[],
	formType: FormType = "survey",
): FormEngineInput {
	const formUuid = asUuid("test-form-uuid");
	const form: Form = {
		uuid: formUuid,
		id: "test-form",
		name: "Test Form",
		type: formType,
		...(caseOperations !== undefined && { caseOperations }),
	} as Form;
	const fieldMap: Record<string, Field> = {};
	const fieldOrder: Record<string, Uuid[]> = {};
	const walk = (nodes: DField[], parentUuid: Uuid, prefix: string): void => {
		const order: Uuid[] = [];
		for (const n of nodes) {
			const uuid = asUuid(`${prefix}.${n.id}`);
			order.push(uuid);
			const { children, ...rest } = n;
			fieldMap[uuid as string] = { uuid, ...rest } as Field;
			if (n.kind === "group" || n.kind === "repeat") {
				walk(children ?? [], uuid, `${prefix}.${n.id}`);
			}
		}
		fieldOrder[parentUuid as string] = order;
	};
	walk(fields, formUuid, "form");
	return { form, formUuid, fields: fieldMap, fieldOrder };
}

const OPERATION: CaseOperation = {
	uuid: asUuid("op.a"),
	id: "op_a",
	action: "update",
	caseType: "patient",
	target: { kind: "session" },
} as CaseOperation;

function valuesOf(
	entries: ReadonlyArray<{ fieldUuid: string; value: unknown }>,
): Record<string, unknown> {
	return Object.fromEntries(entries.map((e) => [e.fieldUuid, e.value]));
}

describe("computeOperationAnswers", () => {
	it("returns undefined for an operation-free form", () => {
		const engine = new FormEngine(
			dTree([{ id: "name", kind: "text", label: "Name" }]),
		);
		expect(engine.computeOperationAnswers()).toBeUndefined();
	});

	it("collects root answers with multi-select token arrays", () => {
		const engine = new FormEngine(
			dTree(
				[
					{ id: "name", kind: "text", label: "Name" },
					{
						id: "symptoms",
						kind: "multi_select",
						label: "Symptoms",
						options: [
							{ value: "fever", label: "Fever" },
							{ value: "cough", label: "Cough" },
						],
					},
					{ id: "note", kind: "label", label: "Just a label" },
				],
				[OPERATION],
			),
		);
		engine.setValue("/data/name", "Ada");
		engine.setValue("/data/symptoms", "fever cough");

		const answers = engine.computeOperationAnswers();
		expect(answers).toBeDefined();
		expect(valuesOf(answers?.root ?? [])).toEqual({
			[asUuid("form.name") as string]: "Ada",
			[asUuid("form.symptoms") as string]: ["fever", "cough"],
		});
		expect(answers?.repeats).toEqual([]);
	});

	it("builds complete per-iteration lists, parent-major, nested scopes excluded", () => {
		const engine = new FormEngine(
			dTree(
				[
					{ id: "region", kind: "text", label: "Region" },
					{
						id: "visits",
						kind: "repeat",
						label: "Visits",
						children: [
							{ id: "visit_note", kind: "text", label: "Note" },
							{
								id: "meds",
								kind: "repeat",
								label: "Meds",
								children: [{ id: "med_name", kind: "text", label: "Med" }],
							},
						],
					},
				],
				[OPERATION],
			),
		);
		engine.setValue("/data/region", "north");
		engine.addRepeat("/data/visits"); // two visit iterations
		engine.setValue("/data/visits[0]/visit_note", "first");
		engine.setValue("/data/visits[1]/visit_note", "second");
		engine.setValue("/data/visits[0]/meds[0]/med_name", "amoxicillin");
		engine.setValue("/data/visits[1]/meds[0]/med_name", "ibuprofen");

		const answers = engine.computeOperationAnswers();
		const visits = answers?.repeats.find(
			(r) => r.repeat === (asUuid("form.visits") as string),
		);
		const meds = answers?.repeats.find(
			(r) => r.repeat === (asUuid("form.visits.meds") as string),
		);
		expect(visits?.iterations).toHaveLength(2);
		expect(meds?.iterations).toHaveLength(2);

		const regionUuid = asUuid("form.region") as string;
		const noteUuid = asUuid("form.visits.visit_note") as string;
		const medUuid = asUuid("form.visits.meds.med_name") as string;

		// Visit iterations: root + own; the nested meds scope is EXCLUDED.
		expect(valuesOf(visits?.iterations[0] ?? [])).toEqual({
			[regionUuid]: "north",
			[noteUuid]: "first",
		});
		expect(valuesOf(visits?.iterations[1] ?? [])).toEqual({
			[regionUuid]: "north",
			[noteUuid]: "second",
		});

		// Med iterations: root + the ENCLOSING visit's concrete answers + own,
		// flattened parent-major (visit 0's med first).
		expect(valuesOf(meds?.iterations[0] ?? [])).toEqual({
			[regionUuid]: "north",
			[noteUuid]: "first",
			[medUuid]: "amoxicillin",
		});
		expect(valuesOf(meds?.iterations[1] ?? [])).toEqual({
			[regionUuid]: "north",
			[noteUuid]: "second",
			[medUuid]: "ibuprofen",
		});
	});

	it("rides the submission mutation on every arm", () => {
		const engine = new FormEngine(
			dTree([{ id: "name", kind: "text", label: "Name" }], [OPERATION]),
		);
		const mutation = engine.computeSubmissionMutation({ caseTypes: [] });
		expect(mutation.kind).toBe("survey");
		if (mutation.kind === "survey") {
			expect(mutation.formUuid).toBe("test-form-uuid");
			expect(mutation.operationAnswers?.root).toBeDefined();
		}
	});
});
