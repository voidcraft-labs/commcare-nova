/**
 * Field-addressing behavior across the field tools — uuid targeting and
 * the ambiguity refusal (`resolveFieldTarget`).
 *
 * Sibling-uniqueness is per parent level, so one form can legally hold
 * two fields with the same bare id in different groups — a bare id is
 * not a unique handle. These tests pin the addressing contract:
 *
 *   - a duplicated bare id is REFUSED with every match's path + uuid;
 *   - a uuid addresses the exact field, wherever it nests;
 *   - `editField`'s post-rename re-read is by uuid, so a rename whose
 *     new id has a twin elsewhere in the form patches the RENAMED
 *     field, never the depth-first twin;
 *   - `addFields`' parent slots refuse an ambiguous container ref the
 *     same way, instead of nesting the batch under the first match.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { backfillOrderKeys } from "@/lib/doc/order/backfill";
import type { BlueprintDoc } from "@/lib/domain";
import { makeStubToolContext } from "../../__tests__/fixtures";
import { addFieldsTool } from "../addFields";
import { editFieldTool } from "../editField";
import { getFieldTool } from "../getField";
import { removeFieldTool } from "../removeField";

vi.mock("@/lib/db/apps", () => ({
	completeApp: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/db/applyBlueprintChange", () => ({
	applyBlueprintChange: vi.fn(() => Promise.resolve({ seq: 0 })),
}));

/** Two groups legally sharing a `patient_name` child — per-level
 *  sibling uniqueness makes the bare id ambiguous form-wide. */
function makeDoc(): BlueprintDoc {
	const doc = buildDoc({
		modules: [
			{
				name: "Clinic",
				forms: [
					{
						name: "Encounter",
						type: "survey",
						fields: [
							f({
								id: "orders",
								kind: "group",
								label: "Orders",
								children: [
									f({ id: "patient_name", kind: "text", label: "In orders" }),
								],
							}),
							f({
								id: "history",
								kind: "group",
								label: "History",
								children: [
									f({ id: "patient_name", kind: "text", label: "In history" }),
								],
							}),
						],
					},
				],
			},
		],
	});
	backfillOrderKeys(doc);
	return doc;
}

function fieldByLabel(doc: BlueprintDoc, label: string) {
	const field = Object.values(doc.fields).find(
		(fld) => "label" in fld && fld.label === label,
	);
	if (!field) throw new Error(`fixture field labeled "${label}" missing`);
	return field;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("editField targeting", () => {
	it("refuses a duplicated bare id and persists nothing", async () => {
		const doc = makeDoc();
		const { ctx, recordMutationStages } = makeStubToolContext();
		const result = await editFieldTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "patient_name",
				updates: { kind: "text", label: "Renamed" },
			},
			ctx,
			doc,
		);
		if (!("error" in result.result)) throw new Error("expected error");
		expect(result.result.error).toContain("ambiguous");
		expect(result.result.error).toContain('"orders/patient_name"');
		expect(result.result.error).toContain('"history/patient_name"');
		expect(recordMutationStages).not.toHaveBeenCalled();
	});

	it("patches exactly the uuid-addressed duplicate, not the DFS-first one", async () => {
		const doc = makeDoc();
		const { ctx } = makeStubToolContext();
		const inHistory = fieldByLabel(doc, "In history");
		const result = await editFieldTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: inHistory.uuid,
				updates: { kind: "text", label: "History patient" },
			},
			ctx,
			doc,
		);
		if ("error" in result.result) throw new Error(result.result.error);
		const after = result.newDoc.fields[inHistory.uuid];
		expect(after && "label" in after ? after.label : "").toBe(
			"History patient",
		);
		const untouched = result.newDoc.fields[fieldByLabel(doc, "In orders").uuid];
		expect(untouched && "label" in untouched ? untouched.label : "").toBe(
			"In orders",
		);
	});

	it("applies the post-rename patch to the renamed field even when the new id has a twin elsewhere", async () => {
		// Rename history's child to `order_note` — an id that ALREADY exists
		// inside the orders group — and patch its label in the same call.
		// Sibling scope allows the rename (different parents); the old
		// id-based re-resolve would have DFS-matched the orders twin and
		// patched THAT field.
		const doc = buildDoc({
			modules: [
				{
					name: "Clinic",
					forms: [
						{
							name: "Encounter",
							type: "survey",
							fields: [
								f({
									id: "orders",
									kind: "group",
									label: "Orders",
									children: [
										f({ id: "order_note", kind: "text", label: "Twin" }),
									],
								}),
								f({
									id: "history",
									kind: "group",
									label: "History",
									children: [
										f({ id: "note", kind: "text", label: "Original" }),
									],
								}),
							],
						},
					],
				},
			],
		});
		backfillOrderKeys(doc);
		const { ctx } = makeStubToolContext();
		const original = fieldByLabel(doc, "Original");
		const result = await editFieldTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "note",
				updates: { kind: "text", id: "order_note", label: "Patched" },
			},
			ctx,
			doc,
		);
		if ("error" in result.result) throw new Error(result.result.error);
		const renamed = result.newDoc.fields[original.uuid];
		expect(renamed?.id).toBe("order_note");
		expect(renamed && "label" in renamed ? renamed.label : "").toBe("Patched");
		const twin = result.newDoc.fields[fieldByLabel(doc, "Twin").uuid];
		expect(twin && "label" in twin ? twin.label : "").toBe("Twin");
	});

	it("treats a uuid-addressed call restating the current id as no rename", async () => {
		const doc = makeDoc();
		const { ctx } = makeStubToolContext();
		const inOrders = fieldByLabel(doc, "In orders");
		const result = await editFieldTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: inOrders.uuid,
				updates: { kind: "text", id: "patient_name", label: "Same id" },
			},
			ctx,
			doc,
		);
		if ("error" in result.result) throw new Error(result.result.error);
		// The id restates the field's current one — no rename happened, so
		// the message reports no rename and the id is unchanged.
		expect(result.result.message).not.toContain("renamed from");
		expect(result.newDoc.fields[inOrders.uuid]?.id).toBe("patient_name");
	});
});

describe("removeField targeting", () => {
	it("refuses a duplicated bare id", async () => {
		const doc = makeDoc();
		const { ctx, recordMutations } = makeStubToolContext();
		const result = await removeFieldTool.execute(
			{ moduleIndex: 0, formIndex: 0, fieldId: "patient_name" },
			ctx,
			doc,
		);
		if (!("error" in result.result)) throw new Error("expected error");
		expect(result.result.error).toContain("ambiguous");
		expect(recordMutations).not.toHaveBeenCalled();
	});

	it("removes exactly the uuid-addressed duplicate and reports its semantic id", async () => {
		const doc = makeDoc();
		const { ctx } = makeStubToolContext();
		const inHistory = fieldByLabel(doc, "In history");
		const result = await removeFieldTool.execute(
			{ moduleIndex: 0, formIndex: 0, fieldId: inHistory.uuid },
			ctx,
			doc,
		);
		if ("error" in result.result) throw new Error(result.result.error);
		expect(result.newDoc.fields[inHistory.uuid]).toBeUndefined();
		expect(
			result.newDoc.fields[fieldByLabel(doc, "In orders").uuid],
		).toBeDefined();
		// The message names the field's id, not the uuid the call passed.
		expect(result.result.message).toContain('"patient_name"');
	});
});

describe("addFields parent targeting", () => {
	/** Two containers legally sharing the id `details` — one at the form's
	 *  top level, one nested — so a bare parent ref is ambiguous. */
	function twoDetailsDoc(): BlueprintDoc {
		const doc = buildDoc({
			modules: [
				{
					name: "Clinic",
					forms: [
						{
							name: "Encounter",
							type: "survey",
							fields: [
								f({
									id: "details",
									kind: "group",
									label: "Top details",
									children: [f({ id: "alpha", kind: "text" })],
								}),
								f({
									id: "wrapper",
									kind: "group",
									label: "Wrapper",
									children: [
										f({
											id: "details",
											kind: "group",
											label: "Nested details",
											children: [f({ id: "bravo", kind: "text" })],
										}),
									],
								}),
							],
						},
					],
				},
			],
		});
		backfillOrderKeys(doc);
		return doc;
	}

	it("refuses an ambiguous batch parentId instead of nesting under the first match", async () => {
		const doc = twoDetailsDoc();
		const { ctx, recordMutations } = makeStubToolContext();
		const result = await addFieldsTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fields: [{ kind: "text", id: "new_q", label: "New question" }],
				parentId: "details",
			},
			ctx,
			doc,
		);
		if (!("error" in result.result)) throw new Error("expected error");
		expect(result.result.error).toContain("ambiguous");
		expect(recordMutations).not.toHaveBeenCalled();
	});

	it("refuses an ambiguous per-field parentId the same way", async () => {
		const doc = twoDetailsDoc();
		const { ctx, recordMutations } = makeStubToolContext();
		const result = await addFieldsTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fields: [
					{
						kind: "text",
						id: "new_q",
						label: "New question",
						parentId: "details",
					},
				],
			},
			ctx,
			doc,
		);
		if (!("error" in result.result)) throw new Error("expected error");
		expect(result.result.error).toContain("ambiguous");
		expect(recordMutations).not.toHaveBeenCalled();
	});

	it("refuses a parentId naming two containers minted in the SAME call", async () => {
		// Two same-id groups under different parents pass the per-level
		// sibling verdict, so the ref would otherwise silently resolve to
		// whichever one the minted map kept.
		const doc = buildDoc({
			modules: [
				{
					name: "Clinic",
					forms: [{ name: "Encounter", type: "survey", fields: [] }],
				},
			],
		});
		backfillOrderKeys(doc);
		const { ctx, recordMutations } = makeStubToolContext();
		const result = await addFieldsTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fields: [
					{ kind: "group", id: "section_a", label: "A" },
					{ kind: "group", id: "section_b", label: "B" },
					{
						kind: "group",
						id: "details",
						label: "Details A",
						parentId: "section_a",
					},
					{
						kind: "group",
						id: "details",
						label: "Details B",
						parentId: "section_b",
					},
					{ kind: "text", id: "note", label: "Note", parentId: "details" },
				],
			},
			ctx,
			doc,
		);
		if (!("error" in result.result)) throw new Error("expected error");
		expect(result.result.error).toContain("distinct ids");
		expect(recordMutations).not.toHaveBeenCalled();
	});

	it("refuses a parentId where a minted container shadows an existing container", async () => {
		// The existing `details` container is NESTED (inside `wrapper`), so
		// the new top-level `details` group passes the per-level sibling
		// verdict — the ref then has two viable referents and must refuse.
		const doc = buildDoc({
			modules: [
				{
					name: "Clinic",
					forms: [
						{
							name: "Encounter",
							type: "survey",
							fields: [
								f({
									id: "wrapper",
									kind: "group",
									label: "Wrapper",
									children: [
										f({
											id: "details",
											kind: "group",
											label: "Existing details",
											children: [f({ id: "alpha", kind: "text" })],
										}),
									],
								}),
							],
						},
					],
				},
			],
		});
		backfillOrderKeys(doc);
		const { ctx, recordMutations } = makeStubToolContext();
		const result = await addFieldsTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fields: [
					{ kind: "group", id: "details", label: "New details" },
					{ kind: "text", id: "note", label: "Note", parentId: "details" },
				],
			},
			ctx,
			doc,
		);
		if (!("error" in result.result)) throw new Error("expected error");
		expect(result.result.error).toContain("share that id");
		expect(recordMutations).not.toHaveBeenCalled();
	});

	it("nests under a minted container whose id matches only an existing LEAF", async () => {
		// A leaf can't be a parent, so the minted group is the only viable
		// referent — no refusal.
		const doc = buildDoc({
			modules: [
				{
					name: "Clinic",
					forms: [
						{
							name: "Encounter",
							type: "survey",
							fields: [
								f({
									id: "grp",
									kind: "group",
									label: "Group",
									children: [f({ id: "details", kind: "text", label: "Leaf" })],
								}),
							],
						},
					],
				},
			],
		});
		backfillOrderKeys(doc);
		const { ctx } = makeStubToolContext();
		const result = await addFieldsTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fields: [
					{ kind: "group", id: "details", label: "New details" },
					{ kind: "text", id: "note", label: "Note", parentId: "details" },
				],
			},
			ctx,
			doc,
		);
		if ("error" in result.result) throw new Error(result.result.error);
		const mintedGroup = Object.values(result.newDoc.fields).find(
			(fld) => "label" in fld && fld.label === "New details",
		);
		const note = Object.values(result.newDoc.fields).find(
			(fld) => fld.id === "note",
		);
		if (!mintedGroup || !note) throw new Error("added fields missing");
		expect(result.newDoc.fieldOrder[mintedGroup.uuid]).toContain(note.uuid);
	});

	it("nests under the uuid-addressed duplicate container", async () => {
		const doc = twoDetailsDoc();
		const { ctx } = makeStubToolContext();
		const nested = fieldByLabel(doc, "Nested details");
		const result = await addFieldsTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fields: [{ kind: "text", id: "new_q", label: "New question" }],
				parentId: nested.uuid,
			},
			ctx,
			doc,
		);
		if ("error" in result.result) throw new Error(result.result.error);
		const added = Object.values(result.newDoc.fields).find(
			(fld) => fld.id === "new_q",
		);
		if (!added) throw new Error("added field missing");
		expect(result.newDoc.fieldOrder[nested.uuid]).toContain(added.uuid);
	});
});

describe("getField targeting", () => {
	it("refuses a duplicated bare id", async () => {
		const doc = makeDoc();
		const { ctx } = makeStubToolContext();
		const result = await getFieldTool.execute(
			{ moduleIndex: 0, formIndex: 0, fieldId: "patient_name" },
			ctx,
			doc,
		);
		if (!("error" in result.data)) throw new Error("expected error");
		expect(result.data.error).toContain("ambiguous");
	});

	it("reads the uuid-addressed duplicate with its nested path", async () => {
		const doc = makeDoc();
		const { ctx } = makeStubToolContext();
		const inHistory = fieldByLabel(doc, "In history");
		const result = await getFieldTool.execute(
			{ moduleIndex: 0, formIndex: 0, fieldId: inHistory.uuid },
			ctx,
			doc,
		);
		if ("error" in result.data) throw new Error(result.data.error);
		expect(result.data.path).toBe("history/patient_name");
		expect(result.data.field.uuid).toBe(inHistory.uuid);
	});
});
