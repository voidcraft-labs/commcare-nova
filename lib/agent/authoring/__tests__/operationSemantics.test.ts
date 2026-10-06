import { expect, it } from "vitest";
import { z } from "zod";
import { makeAuthoringHarness } from "@/lib/agent/__tests__/authoringHarness";
import { namedFormFixture } from "@/lib/agent/__tests__/namedFormFixture";
import { operationSemantics } from "../operationSemantics";

// The real published grammar, shared dispatcher and document gate provide the
// inputs and state. These observations prove contextual feedback and unchanged
// admission, not native execution, SQL isolation or concurrency protection.
const record = z.object({
	kind: z.string(),
	indexPath: z.array(z.string()).optional(),
	operationUuid: z.string().optional(),
	identity: z.string().optional(),
});
const read = z.object({
	caseType: z.string(),
	property: z.string(),
	record,
	slot: z.string(),
	throughFieldUuids: z.array(z.string()),
});
const feedback = z.object({
	operationSemantics: z.object({
		recordView: z.object({
			native: z.string(),
			preview: z.string(),
			formAnswers: z.string(),
			nativeCompareAndSet: z.boolean(),
		}),
		operations: z.array(
			z.object({
				operationUuid: z.string(),
				id: z.string(),
				target: record,
				execution: z.object({
					selectedRecords: z.string(),
					repeatFieldUuid: z.string().optional(),
				}),
				conditionReads: z.array(read),
				valueReads: z.array(read),
				writes: z.array(z.string()),
				readWriteOverlaps: z.array(
					z.object({
						property: z.string(),
						readFrom: z.string(),
						slot: z.string(),
						throughFieldUuids: z.array(z.string()),
						identity: z.string(),
					}),
				),
				unresolvedReads: z.array(
					z.object({ reason: z.string(), slot: z.string() }),
				),
			}),
		),
	}),
});

async function fixture() {
	const h = makeAuthoringHarness(
		{},
		namedFormFixture([
			{
				name: "Entries",
				caseType: "entry",
				forms: [{ name: "Change entry", type: "followup" }],
			},
		]),
	);
	const call = async (name: string, input: unknown) => {
		const result = await h.call(name, input);
		expect(result, name).not.toHaveProperty("error");
		return result;
	};
	await call("generateSchema", {
		caseTypes: [
			{
				name: "group",
				properties: [{ name: "phase", label: "Phase", data_type: "text" }],
			},
			{
				name: "entry",
				parent_type: "group",
				properties: [
					{ name: "phase", label: "Phase", data_type: "text" },
					{ name: "note", label: "Note", data_type: "text" },
					{ name: "contact", label: "Contact", data_type: "text" },
				],
			},
		],
	});
	await call("addFields", {
		formUuid: "Change entry",
		fields: [
			{ kind: "text", id: "note", label: "Note" },
			{ kind: "hidden", id: "phase_copy", calculate: "#case/phase" },
			{ kind: "hidden", id: "phase_copy_again", calculate: "#form/phase_copy" },
			{
				kind: "text",
				id: "contact",
				label: "Contact",
				caseWrite: { caseType: "entry", property: "contact" },
			},
		],
	});
	await call("removeField", {
		formUuid: "Change entry",
		fieldUuid: "fixture_placeholder",
	});
	return { h, call };
}

it("admits guarded writes and reports record identities consistently on both writes and both reads", async () => {
	const { h, call } = await fixture();
	const selected = {
		id: "change_selected",
		action: "update",
		caseType: "entry",
		target: { kind: "session" },
		condition: "#case/phase = 'active'",
		writes: [{ property: "phase", value: "#form/note" }],
	};
	const added = feedback.parse(
		await call("addCaseOperations", {
			formUuid: "Change entry",
			operations: [
				{ operation: selected },
				{
					operation: {
						id: "make_entry",
						action: "create",
						caseType: "entry",
						target: { kind: "new" },
						name: "#form/note",
						condition: "#case/phase = 'active'",
						writes: [{ property: "phase", value: "#case/phase" }],
					},
				},
				{
					operation: {
						id: "change_created",
						action: "update",
						caseType: "entry",
						target: { kind: "op", opUuid: "make_entry" },
						condition: "#case/phase = 'active'",
						writes: [{ property: "phase", value: "'other'" }],
					},
				},
				{
					operation: {
						id: "change_parent",
						action: "update",
						caseType: "group",
						target: {
							kind: "expression",
							expr: "via(ancestor('parent'), #case/case_id)",
						},
						condition: "via(ancestor('parent'), #case/phase) = 'active'",
						writes: [{ property: "phase", value: "'complete'" }],
					},
				},
			],
		}),
	);
	expect(added.operationSemantics.recordView).toEqual({
		native: "initialized-form-record-view",
		preview: "pre-effect-submission-transaction",
		formAnswers: "submitted-entry-values",
		nativeCompareAndSet: false,
	});
	const operations = added.operationSemantics.operations;
	expect(operations[0].readWriteOverlaps).toEqual([
		{
			property: "phase",
			readFrom: "condition",
			slot: "operation",
			throughFieldUuids: [],
			identity: "same-record",
		},
	]);
	// Type equality must not turn these fresh targets into the selected record.
	expect(operations[1].target).toMatchObject({
		kind: "created-record",
		identity: "generated",
	});
	expect(operations[2].target).toEqual(operations[1].target);
	expect(operations[1].readWriteOverlaps).toEqual([]);
	expect(operations[2].readWriteOverlaps).toEqual([]);
	expect(operations[2].conditionReads.map((read) => read.slot)).toEqual([
		"operation",
		`inherited:${operations[1].operationUuid}`,
	]);
	expect(operations[3].target).toEqual({
		kind: "related-record",
		indexPath: ["parent"],
	});
	expect(operations[3].conditionReads).toMatchObject([
		{ caseType: "group", property: "phase", record: operations[3].target },
	]);
	expect(operations[3].readWriteOverlaps).toMatchObject([
		{ property: "phase", identity: "same-record" },
	]);
	const updated = feedback.parse(
		await call("updateCaseOperation", {
			formUuid: "Change entry",
			operationUuid: "change_selected",
			operation: selected,
		}),
	);
	for (const result of [
		updated,
		await call("getCaseOperations", { formUuid: "Change entry" }),
		await call("getForm", { formUuid: "Change entry" }),
	])
		expect(feedback.parse(result)).toEqual(added);
	expect(
		Object.values(h.currentDoc().forms).find(
			(form) => form.name === "Change entry",
		)?.caseOperations,
	).toHaveLength(4);
});

it("separates per-write guards, captured value reads and unguarded writes, and refreshes after rename/update/removal", async () => {
	const { h, call } = await fixture();
	const result = feedback.parse(
		await call("addCaseOperations", {
			formUuid: "Change entry",
			operations: [
				{
					operation: {
						id: "conditional_value",
						action: "update",
						caseType: "entry",
						target: { kind: "session" },
						writes: [
							{
								property: "phase",
								value: "#form/phase_copy_again",
								condition: "#case/phase = 'active'",
							},
						],
					},
				},
				{
					operation: {
						id: "unconditional_value",
						action: "update",
						caseType: "entry",
						target: { kind: "session" },
						writes: [{ property: "phase", value: "'complete'" }],
					},
				},
				{
					operation: {
						id: "dynamic_record",
						action: "update",
						caseType: "entry",
						target: { kind: "expression", expr: "#form/note" },
						condition: "#case/phase = 'active'",
						writes: [{ property: "phase", value: "'complete'" }],
					},
				},
				{
					operation: {
						id: "guarded_contact_value",
						action: "update",
						caseType: "entry",
						target: { kind: "session" },
						condition: "#case/phase = 'active'",
						writes: [{ property: "note", value: "#form/contact" }],
					},
				},
			],
		}),
	);
	const first = result.operationSemantics.operations[0];
	expect(first.conditionReads).toMatchObject([
		{ property: "phase", slot: "write:phase", throughFieldUuids: [] },
	]);
	const fields = Object.values(h.currentDoc().fields);
	const secondCopy = fields.find((field) => field.id === "phase_copy_again");
	const firstCopy = fields.find((field) => field.id === "phase_copy");
	if (!firstCopy || !secondCopy)
		throw new Error("Missing admitted answer dependencies.");
	expect(first.valueReads).toEqual([
		{
			caseType: "entry",
			property: "phase",
			record: { kind: "selected-record" },
			slot: "write:phase",
			throughFieldUuids: [secondCopy.uuid, firstCopy.uuid],
		},
	]);
	expect(first.readWriteOverlaps.map((overlap) => overlap.readFrom)).toEqual([
		"condition",
		"value",
	]);
	expect(result.operationSemantics.operations[1].conditionReads).toEqual([]);
	expect(result.operationSemantics.operations[1].readWriteOverlaps).toEqual([]);
	expect(result.operationSemantics.operations[1].writes).toEqual(["phase"]);
	expect(
		result.operationSemantics.operations[2].readWriteOverlaps,
	).toMatchObject([{ identity: "may-alias" }]);
	const guardedContact = result.operationSemantics.operations[3];
	expect(guardedContact.conditionReads).toMatchObject([
		{ property: "phase", record: { kind: "selected-record" } },
	]);
	expect(guardedContact.valueReads).toMatchObject([
		{ property: "contact", record: { kind: "selected-record" } },
	]);
	expect(guardedContact.readWriteOverlaps).toEqual([]);
	expect(result.operationSemantics.recordView.nativeCompareAndSet).toBe(false);
	await call("editField", {
		fieldUuid: firstCopy.uuid,
		updates: { id: "renamed_source" },
	});
	await call("renameCaseProperties", {
		renames: [{ caseType: "entry", from: "phase", to: "milestone" }],
	});
	const renamed = feedback.parse(
		await call("getForm", { formUuid: "Change entry" }),
	);
	expect(renamed.operationSemantics.operations[0].valueReads).toMatchObject([
		{
			property: "milestone",
			throughFieldUuids: [secondCopy.uuid, firstCopy.uuid],
		},
	]);
	expect(
		renamed.operationSemantics.operations[0].readWriteOverlaps,
	).toHaveLength(2);
	const updated = feedback.parse(
		await call("updateCaseOperation", {
			formUuid: "Change entry",
			operationUuid: "conditional_value",
			operation: {
				id: "conditional_value",
				action: "update",
				caseType: "entry",
				target: { kind: "session" },
				writes: [{ property: "note", value: "'recorded'" }],
			},
		}),
	);
	expect(updated.operationSemantics.operations[0].readWriteOverlaps).toEqual(
		[],
	);
	expect(updated.operationSemantics.operations[0].valueReads).toEqual([]);
	for (const operation of renamed.operationSemantics.operations)
		await call("removeCaseOperation", {
			formUuid: "Change entry",
			operationUuid: operation.operationUuid,
		});
	for (const name of ["getForm", "getCaseOperations"]) {
		const noAdvanced = await call(name, { formUuid: "Change entry" });
		expect(feedback.parse(noAdvanced).operationSemantics.operations).toEqual(
			[],
		);
		expect(noAdvanced).toMatchObject({
			answerWrites: [
				{
					caseType: "entry",
					action: "update",
					answers: [{ property: "contact" }],
				},
			],
		});
	}
});

it("keeps keyed creates as possible aliases and reports contextual XPath and relation reads without guessing identity", async () => {
	const { h, call } = await fixture();
	const key = Object.values(h.currentDoc().fields).find(
		(field) => field.id === "note",
	);
	if (!key) throw new Error("Missing admitted key answer.");
	await call("addFields", {
		formUuid: "Change entry",
		fields: [
			{
				kind: "hidden",
				id: "queried_phase",
				calculate:
					"instance('casedb')/casedb/case[@case_id = #case/case_id]/phase",
			},
		],
	});
	const result = feedback.parse(
		await call("addCaseOperations", {
			formUuid: "Change entry",
			operations: [
				{
					operation: {
						id: "keyed_entry",
						action: "create",
						caseType: "entry",
						target: { kind: "new", idFrom: key.uuid },
						name: "#form/note",
						writes: [{ property: "phase", value: "#case/phase" }],
					},
				},
				{
					operation: {
						id: "contextual_read",
						action: "update",
						caseType: "entry",
						target: { kind: "session" },
						writes: [{ property: "phase", value: "#form/queried_phase" }],
						condition:
							"exists(children('entry', 'peer'), #case/phase = 'active')",
					},
				},
				{
					operation: {
						id: "relation_only",
						action: "update",
						caseType: "entry",
						target: { kind: "session" },
						condition: "exists(children('entry', 'peer'))",
						writes: [{ property: "phase", value: "'complete'" }],
					},
				},
			],
		}),
	);
	expect(result.operationSemantics.operations[0].target).toMatchObject({
		kind: "created-record",
		identity: "authored-key",
	});
	expect(
		result.operationSemantics.operations[0].readWriteOverlaps,
	).toMatchObject([{ identity: "may-alias" }]);
	const contextual = result.operationSemantics.operations[1];
	expect(contextual.conditionReads).toMatchObject([
		{ record: { kind: "runtime-record" } },
	]);
	expect(contextual.readWriteOverlaps).toMatchObject([
		{ readFrom: "condition", identity: "may-alias" },
	]);
	expect(contextual.unresolvedReads).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				reason: "xpath-text-not-inventoried",
				slot: "write:phase",
			}),
			expect.objectContaining({
				reason: "related-record-set",
				slot: "operation",
			}),
		]),
	);
	const relationOnly = result.operationSemantics.operations[2];
	expect(relationOnly.conditionReads).toEqual([]);
	expect(relationOnly.unresolvedReads).toEqual([
		{ reason: "related-record-set", slot: "operation" },
	]);
});

it("inventories a converging admitted answer graph without expanding every path", async () => {
	const { h, call } = await fixture();
	await call("addFields", {
		formUuid: "Change entry",
		fields: Array.from({ length: 16 }, (_, index) => ({
			kind: "hidden",
			id: `combined_${index}`,
			calculate:
				index === 0
					? "concat(#form/phase_copy, #form/contact)"
					: `concat(#form/combined_${index - 1}, #form/combined_${index - 1})`,
		})),
	});
	await call("addCaseOperations", {
		formUuid: "Change entry",
		operations: [
			{
				operation: {
					id: "read_graph",
					action: "update",
					caseType: "entry",
					target: { kind: "session" },
					writes: [{ property: "note", value: "#form/combined_15" }],
				},
			},
		],
	});
	const doc = h.currentDoc();
	const form = Object.values(doc.forms).find(
		(form) => form.name === "Change entry",
	);
	if (!form) throw new Error("Missing admitted form.");
	// Observe reads only; every field value and the production projection stay
	// real. A broad linear budget allows other domain inventories while exposing
	// exponential repeated traversal of this converging graph.
	let fieldReads = 0;
	const observed = {
		...doc,
		fields: new Proxy(doc.fields, {
			get(target, property, receiver) {
				if (Object.hasOwn(target, property)) fieldReads++;
				return Reflect.get(target, property, receiver);
			},
		}),
	};
	const result = operationSemantics(observed, form.uuid).operations[0];
	expect(result.valueReads.map((read) => read.property)).toEqual([
		"phase",
		"contact",
	]);
	expect(fieldReads).toBeLessThan(Object.keys(doc.fields).length * 64);
});
