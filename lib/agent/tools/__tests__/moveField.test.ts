/**
 * Behavioral tests for the `moveField` SA tool.
 *
 * The tool exists so the SA repositions an existing field instead of
 * remove-and-re-adding it (which would mint a new identity and strand
 * every reference). These tests pin the addressing contract:
 *
 *   - an anchor (`beforeFieldUuid` / `afterFieldUuid`) places the field
 *     beside it, inside the ANCHOR's own parent, wherever that is;
 *   - `parentUuid` appends into a container, `parentUuid: null` appends at
 *     the form's top level;
 *   - every reducer warn-and-skip condition (own-subtree destination)
 *     comes back as a real `{ error }`, never a false success;
 *   - a cross-parent move that collides with a sibling id reports the
 *     reducer's dedup rename.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { orderedFieldUuids } from "@/lib/doc/fieldWalk";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { makeStubToolContext } from "../../__tests__/fixtures";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import { applyToDoc } from "../common";
import { moveFieldTool } from "../moveField";

vi.mock("@/lib/db/apps", () => ({
	completeApp: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/db/applyBlueprintChange", () => ({
	applyBlueprintChange: vi.fn(() => Promise.resolve({ seq: 0 })),
}));

/**
 * One survey form: three top-level text fields around a group with two
 * children. Each membership array IS the sequence, so the fixture's
 * declaration order is the order the tool moves fields within.
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

function docParentId(doc: BlueprintDoc, fieldUuid: Uuid): string | undefined {
	const parentUuid = doc.fieldParent[fieldUuid];
	return parentUuid ? doc.fields[parentUuid]?.id : undefined;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("moveField — anchored placement", () => {
	it("reorders within the same parent (afterFieldUuid)", async () => {
		const doc = makeDoc();
		const { ctx } = makeStubToolContext();
		const result = await moveFieldTool.execute(
			{
				moduleUuid: doc.moduleOrder[0],
				formUuid: formUuidOf(doc),
				fieldUuid: uuidOf(doc, "alpha"),
				afterFieldUuid: uuidOf(doc, "bravo"),
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
		expect(result.result.message).toContain('Moved "alpha" after "bravo"');
	});

	it("reorders within the same parent (beforeFieldUuid wins over afterFieldUuid)", async () => {
		const doc = makeDoc();
		const { ctx } = makeStubToolContext();
		const result = await moveFieldTool.execute(
			{
				moduleUuid: doc.moduleOrder[0],
				formUuid: formUuidOf(doc),
				fieldUuid: uuidOf(doc, "charlie"),
				beforeFieldUuid: uuidOf(doc, "alpha"),
				afterFieldUuid: uuidOf(doc, "bravo"),
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
				moduleUuid: doc.moduleOrder[0],
				formUuid: formUuidOf(doc),
				fieldUuid: uuidOf(doc, "alpha"),
				afterFieldUuid: uuidOf(doc, "golf_one"),
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

	it("addresses the moved field and anchor by UUID", async () => {
		const doc = makeDoc();
		const { ctx } = makeStubToolContext();
		const result = await moveFieldTool.execute(
			{
				moduleUuid: doc.moduleOrder[0],
				formUuid: formUuidOf(doc),
				fieldUuid: uuidOf(doc, "alpha"),
				beforeFieldUuid: uuidOf(doc, "charlie"),
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

describe("moveField — parentUuid placement", () => {
	it("appends into a group when parentUuid names one and no anchor is given", async () => {
		const doc = makeDoc();
		const { ctx } = makeStubToolContext();
		const result = await moveFieldTool.execute(
			{
				moduleUuid: doc.moduleOrder[0],
				formUuid: formUuidOf(doc),
				fieldUuid: uuidOf(doc, "alpha"),
				parentUuid: uuidOf(doc, "grp"),
			},
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

	it("moves a nested field to the form's top level on parentUuid: null", async () => {
		const doc = makeDoc();
		const { ctx } = makeStubToolContext();
		const result = await moveFieldTool.execute(
			{
				moduleUuid: doc.moduleOrder[0],
				formUuid: formUuidOf(doc),
				fieldUuid: uuidOf(doc, "golf_one"),
				parentUuid: null,
			},
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
		const { ctx } = makeStubToolContext();
		const nested = Object.values(twinDoc.fields).find(
			(fld) => fld.id === "dup" && "label" in fld && fld.label === "Nested dup",
		);
		if (!nested) throw new Error("fixture field missing");
		const result = await moveFieldTool.execute(
			{
				moduleUuid: twinDoc.moduleOrder[0],
				formUuid: formUuidOf(twinDoc),
				fieldUuid: nested.uuid,
				parentUuid: null,
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
			{
				moduleUuid: doc.moduleOrder[0],
				formUuid: formUuidOf(doc),
				fieldUuid: uuidOf(doc, "alpha"),
			},
			ctx,
			doc,
		);
		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) throw new Error("expected error");
		expect(result.result.error).toContain("Nothing says where");
	});

	it("targets one of two same-id fields by exact UUID", async () => {
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
		const { ctx } = makeStubToolContext();
		const target = Object.values(twin.fields).find(
			(field) => field.id === "dup" && docParentId(twin, field.uuid) === "grp",
		);
		if (!target) throw new Error("nested duplicate is missing");
		const result = await moveFieldTool.execute(
			{
				moduleUuid: twin.moduleOrder[0],
				formUuid: formUuidOf(twin),
				fieldUuid: target.uuid,
				afterFieldUuid: uuidOf(twin, "anchor_field"),
			},
			ctx,
			twin,
		);
		if ("error" in result.result) throw new Error(result.result.error);
		expect(result.newDoc.fields[target.uuid]?.id).toBe("dup_2");
	});

	it("refuses anchoring a field to itself", async () => {
		const doc = makeDoc();
		const { ctx } = makeStubToolContext();
		const result = await moveFieldTool.execute(
			{
				moduleUuid: doc.moduleOrder[0],
				formUuid: formUuidOf(doc),
				fieldUuid: uuidOf(doc, "alpha"),
				afterFieldUuid: uuidOf(doc, "alpha"),
			},
			ctx,
			doc,
		);
		if (!("error" in result.result)) throw new Error("expected error");
		expect(result.result.error).toContain("can't anchor to itself");
	});

	it("reports an error when the commit re-applies onto a peer-changed doc and the reducer skips", async () => {
		// The guarded writer re-applies the mutation onto the FRESH stored
		// doc — here one where a peer deleted the moved field first, so the
		// reducer warn-and-skips while the commit itself succeeds. The tool
		// must verify the landing on the committed doc and refuse to report
		// a move over an unchanged form.
		const doc = makeDoc();
		const peerDoc = applyToDoc(doc, [
			{ kind: "removeField", uuid: uuidOf(doc, "alpha") },
		]);
		const ctx = {
			appId: "test-app",
			userId: "user-1",
			runId: "run-1",
			recordMutations: vi.fn(async (mutations: Mutation[]) => ({
				events: [],
				committedDoc: applyToDoc(peerDoc, mutations),
			})),
			recordMutationStages: vi.fn(),
			recordConversation: vi.fn(),
		} as unknown as ToolExecutionContext;
		const result = await moveFieldTool.execute(
			{
				moduleUuid: doc.moduleOrder[0],
				formUuid: formUuidOf(doc),
				fieldUuid: uuidOf(doc, "alpha"),
				afterFieldUuid: uuidOf(doc, "bravo"),
			},
			ctx,
			doc,
		);
		if (!("error" in result.result)) throw new Error("expected error");
		expect(result.result.error).toContain("didn't land");
	});

	it("refuses moving a container into its own subtree", async () => {
		const doc = makeDoc();
		const { ctx } = makeStubToolContext();
		const result = await moveFieldTool.execute(
			{
				moduleUuid: doc.moduleOrder[0],
				formUuid: formUuidOf(doc),
				fieldUuid: uuidOf(doc, "grp"),
				afterFieldUuid: uuidOf(doc, "golf_one"),
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

	it("refuses a parentUuid naming a non-container", async () => {
		const doc = makeDoc();
		const { ctx } = makeStubToolContext();
		const result = await moveFieldTool.execute(
			{
				moduleUuid: doc.moduleOrder[0],
				formUuid: formUuidOf(doc),
				fieldUuid: uuidOf(doc, "alpha"),
				parentUuid: uuidOf(doc, "bravo"),
			},
			ctx,
			doc,
		);
		if (!("error" in result.result)) throw new Error("expected error");
		expect(result.result.error).toContain("not a group or repeat");
	});

	it("refuses a parentUuid that contradicts the anchor's parent", async () => {
		const doc = makeDoc();
		const { ctx } = makeStubToolContext();
		const result = await moveFieldTool.execute(
			{
				moduleUuid: doc.moduleOrder[0],
				formUuid: formUuidOf(doc),
				fieldUuid: uuidOf(doc, "alpha"),
				afterFieldUuid: uuidOf(doc, "bravo"),
				parentUuid: uuidOf(doc, "grp"),
			},
			ctx,
			doc,
		);
		if (!("error" in result.result)) throw new Error("expected error");
		expect(result.result.error).toContain("not inside");
	});

	it("accepts a parentUuid that agrees with the anchor's parent", async () => {
		const doc = makeDoc();
		const { ctx } = makeStubToolContext();
		const result = await moveFieldTool.execute(
			{
				moduleUuid: doc.moduleOrder[0],
				formUuid: formUuidOf(doc),
				fieldUuid: uuidOf(doc, "alpha"),
				afterFieldUuid: uuidOf(doc, "golf_one"),
				parentUuid: uuidOf(doc, "grp"),
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
