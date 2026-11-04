/**
 * A question's "Saves to" through the shared tools, called the way a client
 * calls them: authored input, the production call body, the commit gate and
 * the reducer. A field stores no destination, so each case asserts what the
 * form's case changes hold afterwards. The writer is controlled; persistence
 * and the MCP transport are separate boundaries.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	type BlueprintDoc,
	fieldCaseWriteViews,
	type OwnCaseOperation,
	type Uuid,
} from "@/lib/domain";
import { expectAdmittedDoc } from "../../__tests__/admittedFixture";
import { makeAuthoringHarness } from "../../__tests__/authoringHarness";
import { namedFormFixture } from "../../__tests__/namedFormFixture";

function setup() {
	const h = makeAuthoringHarness(
		{},
		namedFormFixture([
			{
				name: "Households",
				caseType: "household",
				forms: [{ name: "Visit", type: "followup" }],
			},
		]),
	);
	return h;
}

function visitForm(doc: BlueprintDoc) {
	const form = Object.values(doc.forms).find(
		(candidate) => candidate.name === "Visit",
	);
	if (form === undefined) throw new Error("Missing the visit form.");
	return form;
}

function ownCase(doc: BlueprintDoc): OwnCaseOperation {
	const own = visitForm(doc).caseOperations?.[0];
	if (own?.action !== "own") throw new Error("Missing the own case.");
	return own;
}

function fieldNamed(doc: BlueprintDoc, id: string): Uuid {
	const field = Object.values(doc.fields).find(
		(candidate) => candidate.id === id,
	);
	if (field === undefined) throw new Error(`Missing question ${id}.`);
	return field.uuid;
}

describe("caseWrite on the field tools", () => {
	it("plans an added question's caseWrite into the own case, opening with the case's value", async () => {
		const h = setup();
		const result = await h.call("addFields", {
			formUuid: "Visit",
			fields: [
				{
					kind: "text",
					id: "head",
					label: "Head of household",
					caseWrite: { caseType: "household", property: "head" },
				},
			],
		});

		expect(result).toMatchObject({ ok: true });
		const doc = h.currentDoc();
		const head = fieldNamed(doc, "head");
		// The note says the question was given the case's value as its
		// default: the planner's own note, not a sentence of the tool's.
		const notes = z
			.object({
				notes: z.array(z.object({ uuid: z.string(), note: z.string() })),
			})
			.parse(result).notes;
		expect(notes.filter((note) => note.uuid === head)).toHaveLength(1);
		expect(ownCase(doc).writes).toEqual([
			{
				property: "head",
				value: { kind: "term", term: { kind: "field", uuid: head } },
			},
		]);
		expect(doc.fields[head]).toMatchObject({
			default_value: {
				kind: "term",
				term: { kind: "form-case", caseType: "household", property: "head" },
			},
		});
		expectAdmittedDoc(doc);
	});

	it("reads where a question saves as caseWrites, each with its case change", async () => {
		const h = setup();
		await h.call("addFields", {
			formUuid: "Visit",
			fields: [
				{
					kind: "text",
					id: "head",
					label: "Head of household",
					caseWrite: { caseType: "household", property: "head" },
				},
			],
		});
		const doc = h.currentDoc();
		const read = await h.call("getField", {
			formUuid: "Visit",
			fieldUuid: fieldNamed(doc, "head"),
		});

		expect(read).toMatchObject({
			field: {
				caseWrites: [
					{
						caseType: "household",
						property: "head",
						operationUuid: ownCase(doc).uuid,
					},
				],
			},
		});
		expect(read).not.toHaveProperty("field.caseWrite");
	});

	it("refuses one caseWrite for a question saving to two places and stages nothing", async () => {
		const h = setup();
		await h.call("addFields", {
			formUuid: "Visit",
			fields: [
				{
					kind: "text",
					id: "head",
					label: "Head of household",
					caseWrite: { caseType: "household", property: "head" },
				},
			],
		});
		const own = ownCase(h.currentDoc());
		// The own case saves the same answer a second time.
		expect(
			await h.call("updateCaseOperation", {
				formUuid: "Visit",
				operationUuid: own.uuid,
				operation: {
					action: "own",
					writes: [
						{ property: "head", value: "#form/head" },
						{ property: "contact", value: "#form/head" },
					],
				},
			}),
		).toMatchObject({ ok: true });
		const before = h.currentDoc();
		const head = fieldNamed(before, "head");
		expect(fieldCaseWriteViews(before, head)).toHaveLength(2);
		h.recordMutationStages.mockClear();

		const result = await h.call("editField", {
			formUuid: "Visit",
			fieldUuid: head,
			updates: {
				kind: "text",
				caseWrite: { caseType: "household", property: "notes" },
			},
		});

		expect(result).toHaveProperty("error");
		expect(h.recordMutationStages).not.toHaveBeenCalled();
		expect(h.currentDoc()).toEqual(before);
	});
});

describe("this form's own case on the case change tools", () => {
	it("edits the own case through updateCaseOperation", async () => {
		const h = setup();
		const own = ownCase(h.currentDoc());
		const result = await h.call("updateCaseOperation", {
			formUuid: "Visit",
			operationUuid: own.uuid,
			operation: {
				action: "own",
				writes: [{ property: "visits", value: "1" }],
			},
		});

		expect(result).toMatchObject({ ok: true });
		expect(ownCase(h.currentDoc())).toMatchObject({
			uuid: own.uuid,
			id: own.id,
			writes: [{ property: "visits" }],
		});
		expectAdmittedDoc(h.currentDoc());
	});

	it("refuses removing the own case", async () => {
		const h = setup();
		const before = h.currentDoc();
		const result = await h.call("removeCaseOperation", {
			formUuid: "Visit",
			operationUuid: ownCase(before).uuid,
		});

		expect(result).toHaveProperty("error");
		expect(h.currentDoc()).toEqual(before);
	});
});
