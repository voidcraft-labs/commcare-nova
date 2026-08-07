/**
 * SA `add_fields` anchored insert — a `beforeFieldUuid` / `afterFieldUuid` batch
 * lands at the anchor in `fieldOrder`, not appended. These regressions would
 * fail if the creation batch always appended.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { orderedFieldUuids } from "@/lib/doc/fieldWalk";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { makeToolWorkspaceHarness } from "../../__tests__/fixtures";
import { addFieldsTool } from "../addFields";

/** A one-form survey doc with three text fields (qa, qb, qc), HYDRATED so its
 *  existing fields carry the `order` keys the anchor computes bounds from —
 *  exactly the shape the SA's chokepoint-hydrated session doc has. */
function threeFieldDoc(): BlueprintDoc {
	return hydratePersistedBlueprint(
		toPersistableDoc(
			buildDoc({
				modules: [
					{
						name: "M",
						forms: [
							{
								name: "F",
								type: "survey",
								fields: [
									f({ kind: "text", id: "qa", label: proseText("A") }),
									f({ kind: "text", id: "qb", label: proseText("B") }),
									f({ kind: "text", id: "qc", label: proseText("C") }),
								],
							},
						],
					},
				],
			}),
		),
	);
}

function formUuidOf(doc: BlueprintDoc): Uuid {
	return doc.formOrder[doc.moduleOrder[0]][0];
}

/** The form's top-level fields in DISPLAY order, by id. */
function displayIds(doc: BlueprintDoc): string[] {
	return orderedFieldUuids(doc, formUuidOf(doc)).map(
		(u) => doc.fields[u]?.id ?? "?",
	);
}

function textField(id: string) {
	return { kind: "text" as const, id, label: proseText(id.toUpperCase()) };
}

function address(doc: BlueprintDoc) {
	return { moduleUuid: doc.moduleOrder[0], formUuid: formUuidOf(doc) };
}

function fieldUuidOf(doc: BlueprintDoc, id: string): Uuid {
	const uuid = orderedFieldUuids(doc, formUuidOf(doc)).find(
		(candidate) => doc.fields[candidate]?.id === id,
	);
	if (!uuid) throw new Error(`fixture missing field "${id}"`);
	return uuid;
}

describe("add_fields anchored insert lands at the anchor in display order", () => {
	it("afterFieldUuid places a single field immediately AFTER the anchor", async () => {
		const doc = threeFieldDoc();
		const h = makeToolWorkspaceHarness(doc);
		const out = await h.runTool(addFieldsTool, {
			...address(doc),
			fields: [textField("qx")],
			afterFieldUuid: fieldUuidOf(doc, "qa"),
		});
		expect("message" in out.result).toBe(true);
		expect(displayIds(h.currentDoc())).toEqual(["qa", "qx", "qb", "qc"]);
	});

	it("beforeFieldUuid places a single field immediately BEFORE the anchor", async () => {
		const doc = threeFieldDoc();
		const h = makeToolWorkspaceHarness(doc);
		const out = await h.runTool(addFieldsTool, {
			...address(doc),
			fields: [textField("qx")],
			beforeFieldUuid: fieldUuidOf(doc, "qc"),
		});
		expect("message" in out.result).toBe(true);
		expect(displayIds(h.currentDoc())).toEqual(["qa", "qb", "qx", "qc"]);
	});

	it("a MULTI-field anchored insert lands the run contiguously in input order", async () => {
		const doc = threeFieldDoc();
		const h = makeToolWorkspaceHarness(doc);
		const out = await h.runTool(addFieldsTool, {
			...address(doc),
			fields: [textField("qx"), textField("qy"), textField("qz")],
			afterFieldUuid: fieldUuidOf(doc, "qa"),
		});
		expect("message" in out.result).toBe(true);
		expect(displayIds(h.currentDoc())).toEqual([
			"qa",
			"qx",
			"qy",
			"qz",
			"qb",
			"qc",
		]);
	});

	it("beforeFieldUuid on the FIRST child lands the field ahead of everything", async () => {
		const doc = threeFieldDoc();
		const h = makeToolWorkspaceHarness(doc);
		const out = await h.runTool(addFieldsTool, {
			...address(doc),
			fields: [textField("qx")],
			beforeFieldUuid: fieldUuidOf(doc, "qa"),
		});
		expect("message" in out.result).toBe(true);
		expect(displayIds(h.currentDoc())).toEqual(["qx", "qa", "qb", "qc"]);
	});

	it("afterFieldUuid on the LAST child appends after everything", async () => {
		const doc = threeFieldDoc();
		const h = makeToolWorkspaceHarness(doc);
		const out = await h.runTool(addFieldsTool, {
			...address(doc),
			fields: [textField("qx")],
			afterFieldUuid: fieldUuidOf(doc, "qc"),
		});
		expect("message" in out.result).toBe(true);
		expect(displayIds(h.currentDoc())).toEqual(["qa", "qb", "qc", "qx"]);
	});

	it("no anchor still appends (regression guard for the default path)", async () => {
		const doc = threeFieldDoc();
		const h = makeToolWorkspaceHarness(doc);
		const out = await h.runTool(addFieldsTool, {
			...address(doc),
			fields: [textField("qx")],
		});
		expect("message" in out.result).toBe(true);
		expect(displayIds(h.currentDoc())).toEqual(["qa", "qb", "qc", "qx"]);
	});
});
