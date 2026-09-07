/**
 * Actual tool and workspace placement with controlled host receipts.
 * No native persistence or competing-session claim.
 *
 * The tool exists so the SA repositions an existing field instead of
 * remove-and-re-adding it (which would mint a new identity and strand
 * every reference). These tests pin the addressing contract:
 *
 *   - an anchor (`beforeFieldUuid` / `afterFieldUuid`) places the field
 *     beside it, inside the ANCHOR's own parent, wherever that is;
 *   - `parentUuid` appends into a container, `parentUuid: null` appends at
 *     the form's top level;
 *   - an own-subtree destination
 *     comes back as a real `{ error }`, never a false success;
 *   - a cross-parent move that collides with a sibling id is refused before
 *     dispatch; moving never performs a hidden semantic rename.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { PreparedMutationCandidate } from "@/lib/doc/commitVerdicts";
import { orderedFieldUuids } from "@/lib/doc/fieldWalk";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { proseTemplateText, proseText } from "@/lib/domain/prose";
import { expectAdmittedDoc } from "../../__tests__/admittedFixture";
import { makeToolWorkspaceHarness } from "../../__tests__/fixtures";
import { applyToDoc } from "../common";
import { moveFieldTool } from "../moveField";

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
								label: proseText("Group"),
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
	return expectAdmittedDoc(doc);
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

function fieldAddress(
	doc: BlueprintDoc,
	id: string,
): { moduleUuid: Uuid; formUuid: Uuid; fieldUuid: Uuid } {
	return {
		moduleUuid: doc.moduleOrder[0],
		formUuid: formUuidOf(doc),
		fieldUuid: uuidOf(doc, id),
	};
}

describe("moveField — anchored placement", () => {
	it("reorders within the same parent (afterFieldUuid)", async () => {
		const doc = makeDoc();
		const h = makeToolWorkspaceHarness(doc);
		const result = await h.runTool(moveFieldTool, {
			...fieldAddress(doc, "alpha"),
			afterFieldUuid: uuidOf(doc, "bravo"),
		});
		if ("error" in result.result) throw new Error(result.result.error);
		expectAdmittedDoc(h.currentDoc());
		const newDoc = expectAdmittedDoc(h.currentDoc());
		expect(idsUnder(newDoc, formUuidOf(newDoc))).toEqual([
			"bravo",
			"alpha",
			"charlie",
			"grp",
		]);
		expect(result.result.message).toContain('Moved "alpha" after "bravo"');
	});

	it("reorders within the same parent (beforeFieldUuid wins over afterFieldUuid)", async () => {
		const doc = makeDoc();
		const h = makeToolWorkspaceHarness(doc);
		const result = await h.runTool(moveFieldTool, {
			...fieldAddress(doc, "charlie"),
			beforeFieldUuid: uuidOf(doc, "alpha"),
			afterFieldUuid: uuidOf(doc, "bravo"),
		});
		if ("error" in result.result) throw new Error(result.result.error);
		expectAdmittedDoc(h.currentDoc());
		const newDoc = expectAdmittedDoc(h.currentDoc());
		expect(idsUnder(newDoc, formUuidOf(newDoc))).toEqual([
			"charlie",
			"alpha",
			"bravo",
			"grp",
		]);
	});

	it("derives the destination parent from the anchor — a top-level field lands inside the group", async () => {
		const doc = makeDoc();
		const h = makeToolWorkspaceHarness(doc);
		const result = await h.runTool(moveFieldTool, {
			...fieldAddress(doc, "alpha"),
			afterFieldUuid: uuidOf(doc, "golf_one"),
		});
		if ("error" in result.result) throw new Error(result.result.error);
		expectAdmittedDoc(h.currentDoc());
		const newDoc = expectAdmittedDoc(h.currentDoc());
		const grp = uuidOf(doc, "grp");
		expect(idsUnder(newDoc, grp)).toEqual(["golf_one", "alpha", "golf_two"]);
		expect(idsUnder(newDoc, formUuidOf(newDoc))).toEqual([
			"bravo",
			"charlie",
			"grp",
		]);
	});
});

describe("moveField — parentUuid placement", () => {
	it("appends into a group when parentUuid names one and no anchor is given", async () => {
		const doc = makeDoc();
		const h = makeToolWorkspaceHarness(doc);
		const result = await h.runTool(moveFieldTool, {
			...fieldAddress(doc, "alpha"),
			parentUuid: uuidOf(doc, "grp"),
		});
		if ("error" in result.result) throw new Error(result.result.error);
		expectAdmittedDoc(h.currentDoc());
		expect(idsUnder(h.currentDoc(), uuidOf(doc, "grp"))).toEqual([
			"golf_one",
			"golf_two",
			"alpha",
		]);
		expect(result.result.message).toContain('to the end of "grp"');
	});

	it("moves a nested field to the form's top level on parentUuid: null", async () => {
		const doc = makeDoc();
		const h = makeToolWorkspaceHarness(doc);
		const result = await h.runTool(moveFieldTool, {
			...fieldAddress(doc, "golf_one"),
			parentUuid: null,
		});
		if ("error" in result.result) throw new Error(result.result.error);
		expectAdmittedDoc(h.currentDoc());
		const newDoc = expectAdmittedDoc(h.currentDoc());
		expect(idsUnder(newDoc, formUuidOf(newDoc))).toEqual([
			"alpha",
			"bravo",
			"charlie",
			"grp",
			"golf_one",
		]);
		expect(idsUnder(newDoc, uuidOf(doc, "grp"))).toEqual(["golf_two"]);
	});

	it("refuses a cross-parent collision instead of silently renaming identity text", async () => {
		// A top-level twin of a group child — legal (per-level uniqueness),
		// and the exact collision a cross-parent move must refuse.
		const twinDoc = buildDoc({
			modules: [
				{
					name: "Clinic",
					forms: [
						{
							name: "Encounter",
							type: "survey",
							fields: [
								f({
									id: "dup",
									kind: "text",
									label: proseText("Top-level dup"),
								}),
								f({
									id: "grp",
									kind: "group",
									label: proseText("Group"),
									children: [
										f({
											id: "dup",
											kind: "text",
											label: proseText("Nested dup"),
										}),
									],
								}),
							],
						},
					],
				},
			],
		});
		const h = makeToolWorkspaceHarness(expectAdmittedDoc(twinDoc));
		const nested = Object.values(twinDoc.fields).find(
			(fld) =>
				fld.id === "dup" &&
				"label" in fld &&
				fld.label !== undefined &&
				proseTemplateText(fld.label) === "Nested dup",
		);
		if (!nested) throw new Error("fixture field missing");
		const result = await h.runTool(moveFieldTool, {
			moduleUuid: twinDoc.moduleOrder[0],
			formUuid: formUuidOf(twinDoc),
			fieldUuid: nested.uuid,
			parentUuid: null,
		});
		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) throw new Error("expected error");
		expect(h.recordMutations).not.toHaveBeenCalled();
		expect(result.result.error).toContain("same ID");
		expect(result.result.error).toContain("Rename this field explicitly");
		expect(h.currentDoc()).toEqual(twinDoc);
	});
});

describe("moveField — refusals", () => {
	it("refuses a call that names no placement", async () => {
		const doc = makeDoc();
		const h = makeToolWorkspaceHarness(doc);
		const result = await h.runTool(moveFieldTool, fieldAddress(doc, "alpha"));
		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) throw new Error("expected error");
		expect(h.recordMutations).not.toHaveBeenCalled();
		expect(result.result.error).toContain("Nothing says where");
	});

	it("refuses anchoring a field to itself", async () => {
		const doc = makeDoc();
		const h = makeToolWorkspaceHarness(doc);
		const result = await h.runTool(moveFieldTool, {
			...fieldAddress(doc, "alpha"),
			afterFieldUuid: uuidOf(doc, "alpha"),
		});
		if (!("error" in result.result)) throw new Error("expected error");
		expect(h.recordMutations).not.toHaveBeenCalled();
		expect(result.result.error).toContain("can't anchor to itself");
	});

	it("refuses to report a move when the controlled host receipt omits the field", async () => {
		const doc = makeDoc();
		const absentDoc = expectAdmittedDoc(
			applyToDoc(doc, [{ kind: "removeField", uuid: uuidOf(doc, "alpha") }]),
		);
		const h = makeToolWorkspaceHarness(doc);
		h.recordMutations.mockImplementation(
			async (_prepared: PreparedMutationCandidate) => ({
				events: [],
				committedDoc: absentDoc,
			}),
		);
		const result = await h.runTool(moveFieldTool, {
			...fieldAddress(doc, "alpha"),
			afterFieldUuid: uuidOf(doc, "bravo"),
		});
		if (!("error" in result.result))
			throw new Error("expected receipt refusal");
		expect(result.result.error).toContain("didn't land");
		expect(h.currentDoc()).toEqual(absentDoc);
	});

	it("refuses moving a container into its own subtree", async () => {
		const doc = makeDoc();
		const h = makeToolWorkspaceHarness(doc);
		const result = await h.runTool(moveFieldTool, {
			...fieldAddress(doc, "grp"),
			afterFieldUuid: uuidOf(doc, "golf_one"),
		});
		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) throw new Error("expected error");
		expect(h.recordMutations).not.toHaveBeenCalled();
		expect(result.result.error).toContain("own subtree");
		// Nothing changed — no false success over a reducer skip.
		expect(h.currentDoc()).toEqual(doc);
	});

	it("refuses a parentUuid naming a non-container, pointing at the anchor style", async () => {
		const doc = makeDoc();
		const h = makeToolWorkspaceHarness(doc);
		const result = await h.runTool(moveFieldTool, {
			...fieldAddress(doc, "alpha"),
			parentUuid: uuidOf(doc, "bravo"),
		});
		if (!("error" in result.result)) throw new Error("expected error");
		expect(h.recordMutations).not.toHaveBeenCalled();
		expect(result.result.error).toContain("not a group, repeat, or section");
	});

	it("refuses a parentUuid that contradicts the anchor's parent", async () => {
		const doc = makeDoc();
		const h = makeToolWorkspaceHarness(doc);
		const result = await h.runTool(moveFieldTool, {
			...fieldAddress(doc, "alpha"),
			afterFieldUuid: uuidOf(doc, "bravo"),
			parentUuid: uuidOf(doc, "grp"),
		});
		if (!("error" in result.result)) throw new Error("expected error");
		expect(h.recordMutations).not.toHaveBeenCalled();
		expect(result.result.error).toContain(
			'Anchor "bravo" sits at the form\'s top level',
		);
	});

	it("accepts a parentUuid that agrees with the anchor's parent", async () => {
		const doc = makeDoc();
		const h = makeToolWorkspaceHarness(doc);
		const result = await h.runTool(moveFieldTool, {
			...fieldAddress(doc, "alpha"),
			afterFieldUuid: uuidOf(doc, "golf_one"),
			parentUuid: uuidOf(doc, "grp"),
		});
		if ("error" in result.result) throw new Error(result.result.error);
		expectAdmittedDoc(h.currentDoc());
		expect(idsUnder(h.currentDoc(), uuidOf(doc, "grp"))).toEqual([
			"golf_one",
			"alpha",
			"golf_two",
		]);
	});
});
