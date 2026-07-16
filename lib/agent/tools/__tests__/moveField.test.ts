/**
 * Behavioral tests for the `moveField` SA tool.
 *
 * The tool exists so the SA repositions an existing field instead of
 * remove-and-re-adding it (which would mint a new identity and strand
 * every reference). These tests pin the addressing contract:
 *
 *   - an anchor (`beforeFieldId` / `afterFieldId`) places the field
 *     beside it, inside the ANCHOR's own parent, wherever that is;
 *   - `parentId` appends into a container, `parentId: null` appends at
 *     the form's top level;
 *   - every reducer warn-and-skip condition (own-subtree destination)
 *     comes back as a real `{ error }`, never a false success;
 *   - a cross-parent move that collides with a sibling id reports the
 *     reducer's dedup rename.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { orderedFieldUuids } from "@/lib/doc/fieldWalk";
import { backfillOrderKeys } from "@/lib/doc/order/backfill";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { makeStubToolContext } from "../../__tests__/fixtures";
import { moveFieldTool } from "../moveField";

vi.mock("@/lib/db/apps", () => ({
	completeApp: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/db/applyBlueprintChange", () => ({
	applyBlueprintChange: vi.fn(() => Promise.resolve({ seq: 0 })),
}));

/**
 * One survey form: three top-level text fields around a group with two
 * children. Order keys are backfilled so `keysForSlot` sees the same
 * keyed siblings a hydrated doc would carry.
 *
 *   alpha, bravo, charlie, grp[ golf_one, golf_two ]
 */
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
							f({ id: "alpha", kind: "text" }),
							f({ id: "bravo", kind: "text" }),
							f({ id: "charlie", kind: "text" }),
							f({
								id: "grp",
								kind: "group",
								label: "Group",
								children: [
									f({ id: "golf_one", kind: "text" }),
									f({ id: "golf_two", kind: "text" }),
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

function uuidOf(doc: BlueprintDoc, id: string): Uuid {
	const field = Object.values(doc.fields).find((fld) => fld.id === id);
	if (!field) throw new Error(`fixture field "${id}" missing`);
	return field.uuid;
}

/** Display-ordered field ids under a parent (form or container). */
function idsUnder(doc: BlueprintDoc, parentUuid: Uuid): string[] {
	return orderedFieldUuids(doc, parentUuid).map(
		(u) => doc.fields[u]?.id ?? "?",
	);
}

function formUuidOf(doc: BlueprintDoc): Uuid {
	return doc.formOrder[doc.moduleOrder[0]][0];
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("moveField — anchored placement", () => {
	it("reorders within the same parent (afterFieldId)", async () => {
		const doc = makeDoc();
		const { ctx } = makeStubToolContext();
		const result = await moveFieldTool.execute(
			{ moduleIndex: 0, formIndex: 0, fieldId: "alpha", afterFieldId: "bravo" },
			ctx,
			doc,
		);
		if ("error" in result.result) throw new Error(result.result.error);
		expect(idsUnder(result.newDoc, formUuidOf(result.newDoc))).toEqual([
			"bravo",
			"alpha",
			"charlie",
			"grp",
		]);
		expect(result.result.message).toContain('Moved "alpha" after "bravo"');
	});

	it("reorders within the same parent (beforeFieldId wins over afterFieldId)", async () => {
		const doc = makeDoc();
		const { ctx } = makeStubToolContext();
		const result = await moveFieldTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "charlie",
				beforeFieldId: "alpha",
				afterFieldId: "bravo",
			},
			ctx,
			doc,
		);
		if ("error" in result.result) throw new Error(result.result.error);
		expect(idsUnder(result.newDoc, formUuidOf(result.newDoc))).toEqual([
			"charlie",
			"alpha",
			"bravo",
			"grp",
		]);
	});

	it("derives the destination parent from the anchor — a top-level field lands inside the group", async () => {
		const doc = makeDoc();
		const { ctx } = makeStubToolContext();
		const result = await moveFieldTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "alpha",
				afterFieldId: "golf_one",
			},
			ctx,
			doc,
		);
		if ("error" in result.result) throw new Error(result.result.error);
		const grp = uuidOf(doc, "grp");
		expect(idsUnder(result.newDoc, grp)).toEqual([
			"golf_one",
			"alpha",
			"golf_two",
		]);
		expect(idsUnder(result.newDoc, formUuidOf(result.newDoc))).toEqual([
			"bravo",
			"charlie",
			"grp",
		]);
	});

	it("accepts uuids for the moved field and the anchor", async () => {
		const doc = makeDoc();
		const { ctx } = makeStubToolContext();
		const result = await moveFieldTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: uuidOf(doc, "alpha"),
				beforeFieldId: uuidOf(doc, "charlie"),
			},
			ctx,
			doc,
		);
		if ("error" in result.result) throw new Error(result.result.error);
		expect(idsUnder(result.newDoc, formUuidOf(result.newDoc))).toEqual([
			"bravo",
			"alpha",
			"charlie",
			"grp",
		]);
	});
});

describe("moveField — parentId placement", () => {
	it("appends into a group when parentId names one and no anchor is given", async () => {
		const doc = makeDoc();
		const { ctx } = makeStubToolContext();
		const result = await moveFieldTool.execute(
			{ moduleIndex: 0, formIndex: 0, fieldId: "alpha", parentId: "grp" },
			ctx,
			doc,
		);
		if ("error" in result.result) throw new Error(result.result.error);
		expect(idsUnder(result.newDoc, uuidOf(doc, "grp"))).toEqual([
			"golf_one",
			"golf_two",
			"alpha",
		]);
		expect(result.result.message).toContain('to the end of "grp"');
	});

	it("moves a nested field to the form's top level on parentId: null", async () => {
		const doc = makeDoc();
		const { ctx } = makeStubToolContext();
		const result = await moveFieldTool.execute(
			{ moduleIndex: 0, formIndex: 0, fieldId: "golf_one", parentId: null },
			ctx,
			doc,
		);
		if ("error" in result.result) throw new Error(result.result.error);
		expect(idsUnder(result.newDoc, formUuidOf(result.newDoc))).toEqual([
			"alpha",
			"bravo",
			"charlie",
			"grp",
			"golf_one",
		]);
		expect(idsUnder(result.newDoc, uuidOf(doc, "grp"))).toEqual(["golf_two"]);
	});

	it("reports the reducer's dedup rename when the new level already holds the id", async () => {
		// A top-level twin of a group child — legal (per-level uniqueness),
		// and the exact collision a cross-parent move must dedup.
		const twinDoc = buildDoc({
			modules: [
				{
					name: "Clinic",
					forms: [
						{
							name: "Encounter",
							type: "survey",
							fields: [
								f({ id: "dup", kind: "text", label: "Top-level dup" }),
								f({
									id: "grp",
									kind: "group",
									label: "Group",
									children: [
										f({ id: "dup", kind: "text", label: "Nested dup" }),
									],
								}),
							],
						},
					],
				},
			],
		});
		backfillOrderKeys(twinDoc);
		const { ctx } = makeStubToolContext();
		const nested = Object.values(twinDoc.fields).find(
			(fld) => fld.id === "dup" && "label" in fld && fld.label === "Nested dup",
		);
		if (!nested) throw new Error("fixture field missing");
		const result = await moveFieldTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: nested.uuid,
				parentId: null,
			},
			ctx,
			twinDoc,
		);
		if ("error" in result.result) throw new Error(result.result.error);
		expect(result.newDoc.fields[nested.uuid]?.id).toBe("dup_2");
		expect(result.result.message).toContain('Renamed to "dup_2"');
	});
});

describe("moveField — refusals", () => {
	it("refuses a call that names no placement", async () => {
		const doc = makeDoc();
		const { ctx } = makeStubToolContext();
		const result = await moveFieldTool.execute(
			{ moduleIndex: 0, formIndex: 0, fieldId: "alpha" },
			ctx,
			doc,
		);
		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) throw new Error("expected error");
		expect(result.result.error).toContain("Nothing says where");
	});

	it("refuses an ambiguous bare id with every match listed", async () => {
		const twin = buildDoc({
			modules: [
				{
					name: "Clinic",
					forms: [
						{
							name: "Encounter",
							type: "survey",
							fields: [
								f({ id: "dup", kind: "text" }),
								f({
									id: "grp",
									kind: "group",
									label: "Group",
									children: [f({ id: "dup", kind: "text" })],
								}),
								f({ id: "anchor_field", kind: "text" }),
							],
						},
					],
				},
			],
		});
		backfillOrderKeys(twin);
		const { ctx } = makeStubToolContext();
		const result = await moveFieldTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "dup",
				afterFieldId: "anchor_field",
			},
			ctx,
			twin,
		);
		if (!("error" in result.result)) throw new Error("expected error");
		expect(result.result.error).toContain("ambiguous");
		expect(result.result.error).toContain('"grp/dup"');
	});

	it("refuses anchoring a field to itself", async () => {
		const doc = makeDoc();
		const { ctx } = makeStubToolContext();
		const result = await moveFieldTool.execute(
			{ moduleIndex: 0, formIndex: 0, fieldId: "alpha", afterFieldId: "alpha" },
			ctx,
			doc,
		);
		if (!("error" in result.result)) throw new Error("expected error");
		expect(result.result.error).toContain("can't anchor to itself");
	});

	it("refuses moving a container into its own subtree", async () => {
		const doc = makeDoc();
		const { ctx } = makeStubToolContext();
		const result = await moveFieldTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "grp",
				afterFieldId: "golf_one",
			},
			ctx,
			doc,
		);
		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) throw new Error("expected error");
		expect(result.result.error).toContain("own subtree");
		// Nothing changed — no false success over a reducer skip.
		expect(result.newDoc).toBe(doc);
	});

	it("refuses a parentId naming a non-container, pointing at the anchor style", async () => {
		const doc = makeDoc();
		const { ctx } = makeStubToolContext();
		const result = await moveFieldTool.execute(
			{ moduleIndex: 0, formIndex: 0, fieldId: "alpha", parentId: "bravo" },
			ctx,
			doc,
		);
		if (!("error" in result.result)) throw new Error("expected error");
		expect(result.result.error).toContain("not a group or repeat");
	});

	it("refuses a parentId that contradicts the anchor's parent", async () => {
		const doc = makeDoc();
		const { ctx } = makeStubToolContext();
		const result = await moveFieldTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "alpha",
				afterFieldId: "bravo",
				parentId: "grp",
			},
			ctx,
			doc,
		);
		if (!("error" in result.result)) throw new Error("expected error");
		expect(result.result.error).toContain("the anchor's parent wins");
	});

	it("accepts a parentId that AGREES with the anchor's parent", async () => {
		const doc = makeDoc();
		const { ctx } = makeStubToolContext();
		const result = await moveFieldTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "alpha",
				afterFieldId: "golf_one",
				parentId: "grp",
			},
			ctx,
			doc,
		);
		if ("error" in result.result) throw new Error(result.result.error);
		expect(idsUnder(result.newDoc, uuidOf(doc, "grp"))).toEqual([
			"golf_one",
			"alpha",
			"golf_two",
		]);
	});
});
