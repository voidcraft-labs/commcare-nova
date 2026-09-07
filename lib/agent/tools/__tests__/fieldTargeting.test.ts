/**
 * Canonical UUID addressing across the field tools.
 *
 * Semantic ids remain editable wire names and may repeat beneath different
 * parents. They are never accepted as tool addresses; every read, edit,
 * removal, anchor, and parent relationship uses stable identity.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { proseTemplateText, proseText } from "@/lib/domain/prose";
import { expectAdmittedDoc } from "../../__tests__/admittedFixture";
import { makeToolWorkspaceHarness } from "../../__tests__/fixtures";
import { addFieldsTool } from "../addFields";
import { editFieldInputSchema, editFieldTool } from "../editField";
import { getFieldInputSchema, getFieldTool } from "../getField";
import { removeFieldInputSchema, removeFieldTool } from "../removeField";

function makeDoc(): BlueprintDoc {
	return expectAdmittedDoc(
		buildDoc({
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
										f({
											id: "patient_name",
											kind: "text",
											label: "In orders",
										}),
									],
								}),
								f({
									id: "history",
									kind: "group",
									label: "History",
									children: [
										f({
											id: "patient_name",
											kind: "text",
											label: "In history",
										}),
									],
								}),
							],
						},
					],
				},
			],
		}),
	);
}

function address(doc: BlueprintDoc): {
	moduleUuid: Uuid;
	formUuid: Uuid;
} {
	const moduleUuid = doc.moduleOrder[0];
	return { moduleUuid, formUuid: doc.formOrder[moduleUuid][0] };
}

function fieldByLabel(doc: BlueprintDoc, label: string) {
	const field = Object.values(doc.fields).find(
		(candidate) =>
			"label" in candidate &&
			candidate.label !== undefined &&
			proseTemplateText(candidate.label) === label,
	);
	if (field === undefined) throw new Error(`field labeled "${label}" missing`);
	return field;
}

describe("field UUID addresses", () => {
	it("rejects positional and semantic-id address aliases even alongside a valid UUID address at the three field schemas", () => {
		const doc = makeDoc();
		const oldAddress = {
			...address(doc),
			fieldUuid: fieldByLabel(doc, "In history").uuid,
			moduleIndex: 0,
			formIndex: 0,
			fieldId: "patient_name",
		};
		expect(
			editFieldInputSchema.safeParse({
				...oldAddress,
				updates: { kind: "text", label: proseText("Renamed") },
			}).success,
		).toBe(false);
		expect(getFieldInputSchema.safeParse(oldAddress).success).toBe(false);
		expect(removeFieldInputSchema.safeParse(oldAddress).success).toBe(false);
	});

	it("patches exactly the UUID-addressed duplicate", async () => {
		const doc = makeDoc();
		const inHistory = fieldByLabel(doc, "In history");
		const h = makeToolWorkspaceHarness(doc);
		const result = await h.runTool(editFieldTool, {
			...address(doc),
			fieldUuid: inHistory.uuid,
			updates: { kind: "text", label: proseText("History patient") },
		});

		expect(result.result).not.toHaveProperty("error");
		const newDoc = expectAdmittedDoc(h.currentDoc());
		const changed = newDoc.fields[inHistory.uuid];
		expect(
			changed &&
				"label" in changed &&
				changed.label !== undefined &&
				proseTemplateText(changed.label),
		).toBe("History patient");
		const untouched = newDoc.fields[fieldByLabel(doc, "In orders").uuid];
		expect(
			untouched &&
				"label" in untouched &&
				untouched.label !== undefined &&
				proseTemplateText(untouched.label),
		).toBe("In orders");
	});

	it("keeps post-rename edits on the same identity", async () => {
		const doc = makeDoc();
		const inHistory = fieldByLabel(doc, "In history");
		const h = makeToolWorkspaceHarness(doc);
		await h.runTool(editFieldTool, {
			...address(doc),
			fieldUuid: inHistory.uuid,
			updates: {
				kind: "text",
				id: "order_note",
				label: proseText("Renamed history"),
			},
		});

		const second = await h.runTool(editFieldTool, {
			...address(doc),
			fieldUuid: inHistory.uuid,
			updates: { kind: "text", help: proseText("Use the renamed field") },
		});
		expect(second.result).not.toHaveProperty("error");
		expectAdmittedDoc(h.currentDoc());
		expect(h.currentDoc().fields[inHistory.uuid]).toMatchObject({
			uuid: inHistory.uuid,
			id: "order_note",
			label: proseText("Renamed history"),
			help: proseText("Use the renamed field"),
		});
	});

	it("removes only the UUID-addressed duplicate", async () => {
		const doc = makeDoc();
		const inOrders = fieldByLabel(doc, "In orders");
		const inHistory = fieldByLabel(doc, "In history");
		const h = makeToolWorkspaceHarness(doc);
		const result = await h.runTool(removeFieldTool, {
			...address(doc),
			fieldUuid: inOrders.uuid,
		});

		expect(result.result).not.toHaveProperty("error");
		expectAdmittedDoc(h.currentDoc());
		expect(h.currentDoc().fields[inOrders.uuid]).toBeUndefined();
		expect(h.currentDoc().fields[inHistory.uuid]).toBeDefined();
	});

	it("reads the canonical identity without projecting a path address", async () => {
		const doc = makeDoc();
		const inHistory = fieldByLabel(doc, "In history");
		const h = makeToolWorkspaceHarness(doc);
		const read = await h.runTool(getFieldTool, {
			...address(doc),
			fieldUuid: inHistory.uuid,
		});

		expect(read.data).toMatchObject({
			...address(doc),
			fieldUuid: inHistory.uuid,
			field: { uuid: inHistory.uuid, id: "patient_name" },
		});
		expect(read.data).not.toHaveProperty("path");
	});
});

describe("field parent identity", () => {
	it("nests under an existing container UUID", async () => {
		const doc = makeDoc();
		const history = fieldByLabel(doc, "History");
		const newFieldUuid = testUuid("history-note");
		const h = makeToolWorkspaceHarness(doc);
		const result = await h.runTool(addFieldsTool, {
			...address(doc),
			parentUuid: history.uuid,
			fields: [
				{
					fieldUuid: newFieldUuid,
					id: "note",
					kind: "text",
					label: proseText("Note"),
				},
			],
		});

		expect(result.result).not.toHaveProperty("error");
		expectAdmittedDoc(h.currentDoc());
		expect(h.currentDoc().fieldParent[newFieldUuid]).toBe(history.uuid);
	});

	it("predeclares same-call parent and child UUIDs", async () => {
		const doc = makeDoc();
		const sectionUuid = testUuid("same-call-section");
		const childUuid = testUuid("same-call-child");
		const h = makeToolWorkspaceHarness(doc);
		const result = await h.runTool(addFieldsTool, {
			...address(doc),
			fields: [
				{
					fieldUuid: sectionUuid,
					id: "section",
					kind: "group",
					label: proseText("Section"),
				},
				{
					fieldUuid: childUuid,
					parentUuid: sectionUuid,
					id: "note",
					kind: "text",
					label: proseText("Note"),
				},
			],
		});

		expect(result.result).not.toHaveProperty("error");
		expectAdmittedDoc(h.currentDoc());
		expect(h.currentDoc().fieldParent[childUuid]).toBe(sectionUuid);
	});

	it("rejects a leaf UUID as a parent", async () => {
		const doc = makeDoc();
		const leaf = fieldByLabel(doc, "In history");
		const h = makeToolWorkspaceHarness(doc);
		const result = await h.runTool(addFieldsTool, {
			...address(doc),
			parentUuid: leaf.uuid,
			fields: [
				{
					fieldUuid: testUuid("invalid-child"),
					id: "note",
					kind: "text",
					label: proseText("Note"),
				},
			],
		});

		expect(result.result).toHaveProperty("error");
		expect(result.mutations).toEqual([]);
		expect(h.currentDoc()).toEqual(doc);
		expect(h.recordMutations).not.toHaveBeenCalled();
	});
});
