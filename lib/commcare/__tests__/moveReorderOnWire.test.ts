/**
 * A granular move re-sequences the WIRE — `moveField`, `moveOption`,
 * `moveColumn`, `moveModule`.
 *
 * The behavioral guard over the full path (mutation → doc → wire emitter): an
 * emitter that walked its own copy of a sequence, or resolved a positional
 * reference against a stale one, fails here rather than in prod.
 */

import { isTag } from "domhandler";
import { findAll, textContent } from "domutils";
import { parseDocument } from "htmlparser2";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { HqApplication } from "@/lib/commcare";
import { expandDoc } from "@/lib/commcare/expander";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { applyMutations } from "@/lib/doc/mutations";
import type { BlueprintDoc } from "@/lib/domain";
import { blueprintDocSchema, plainColumn } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { runValidation } from "../validator/runner";

/** The first form's XForm attachment, as a string. */
function firstFormXml(doc: BlueprintDoc): string {
	const attachments = expandDoc(admitted(doc))._attachments;
	const key = Object.keys(attachments).find((k) => k.endsWith(".xml"));
	if (key === undefined) throw new Error("no form attachment");
	return attachments[key];
}

function admitted(doc: BlueprintDoc) {
	blueprintDocSchema.parse(toPersistableDoc(doc));
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	return doc;
}
function elements(xml: string, name: string) {
	return findAll(
		(e) => e.name === name,
		parseDocument(xml, { xmlMode: true }).children,
	);
}

/**
 * The first emitted `form_links` entry across the app, with the HQ ids it
 * names resolved back to their emitted positions — HQ's `FormLink` speaks
 * `form_id` / `form_module_id`, and the test cares where those point.
 */
function firstFormLinkTarget(app: HqApplication): {
	moduleIndex: number;
	formIndex: number;
} {
	for (const module of app.modules) {
		for (const form of module.forms) {
			const link = form.form_links[0];
			if (link === undefined) continue;
			if (!("form_id" in link)) throw new Error("expected a form target");
			const moduleIndex = app.modules.findIndex(
				(candidate) => candidate.unique_id === link.form_module_id,
			);
			const formIndex =
				app.modules[moduleIndex]?.forms.findIndex(
					(candidate) => candidate.unique_id === link.form_id,
				) ?? -1;
			return { moduleIndex, formIndex };
		}
	}
	throw new Error("no form_links emitted");
}

describe("a move reflects on the wire", () => {
	it("a same-parent moveField re-sequences the emitted XForm binds", () => {
		const doc = buildDoc({
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
		});
		const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
		const [, , uc] = doc.fieldOrder[formUuid];
		// Move qc to the FRONT.
		admitted(doc);
		const next = produce(doc, (d) => {
			applyMutations(
				d,
				admitMutationBatch([
					{ kind: "moveField", uuid: uc, toParentUuid: formUuid, after: null },
				]),
			);
		});
		const xml = firstFormXml(next);
		expect(
			elements(xml, "bind")
				.filter((e) =>
					["/data/qa", "/data/qb", "/data/qc"].includes(e.attribs.nodeset),
				)
				.map((e) => e.attribs.nodeset),
		).toEqual(["/data/qc", "/data/qa", "/data/qb"]);
		expect(elements(xml, "input").map((e) => e.attribs.ref)).toEqual([
			"/data/qc",
			"/data/qa",
			"/data/qb",
		]);
	});

	it("a moveOption re-sequences the emitted select items", () => {
		const doc = buildDoc({
			modules: [
				{
					name: "M",
					forms: [
						{
							name: "F",
							type: "survey",
							fields: [
								f({
									kind: "single_select",
									id: "color",
									label: proseText("Color"),
									options: [
										{ value: "red", label: "Red" },
										{ value: "green", label: "Green" },
										{ value: "blue", label: "Blue" },
									],
								}),
							],
						},
					],
				},
			],
		});
		const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
		const fieldUuid = doc.fieldOrder[formUuid][0];
		const field = doc.fields[fieldUuid];
		if (!("optionsSource" in field) || field.optionsSource.kind !== "inline") {
			throw new Error("fixture must be an inline select");
		}
		const blueUuid = field.optionsSource.options[2].uuid;
		// Move "blue" to the FRONT.
		admitted(doc);
		const next = produce(doc, (d) => {
			applyMutations(
				d,
				admitMutationBatch([
					{ kind: "moveOption", fieldUuid, uuid: blueUuid, after: null },
				]),
			);
		});
		const xml = firstFormXml(next);
		expect(
			elements(xml, "item").map((item) =>
				textContent(
					item.children.filter((e) => isTag(e) && e.name === "value"),
				),
			),
		).toEqual(["blue", "red", "green"]);
	});

	it("a moveColumn re-sequences the emitted case-list detail columns", () => {
		const c1 = testUuid("col-1");
		const c2 = testUuid("col-2");
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "age", label: proseText("Age") }],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListOnly: true,
					caseListConfig: {
						columns: [
							plainColumn(c1, "case_name", "Name"),
							plainColumn(c2, "age", "Age"),
						],
						listColumnOrder: [c1, c2],
						detailColumnOrder: [c1, c2],
						searchInputs: [],
					},
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		// Move "Age" (col-2) before "Name" (col-1) on Results.
		admitted(doc);
		const next = produce(doc, (d) => {
			applyMutations(
				d,
				admitMutationBatch([
					{
						kind: "moveColumn",
						moduleUuid,
						uuid: c2,
						surface: "list",
						after: null,
					},
				]),
			);
		});
		const hqMod = expandDoc(admitted(next)).modules[0];
		const headers = hqMod.case_details.short.columns.map(
			(col) => col.header.en,
		);
		// "Age" now precedes "Name" on the wire.
		expect(headers).toEqual(["Age", "Name"]);
		expect(hqMod.case_details.long.columns.map((c) => c.header.en)).toEqual([
			"Name",
			"Age",
		]);
	});

	it("a form_links target survives a module reorder (points at the display-moved menu)", () => {
		const doc = buildDoc({
			modules: [
				{
					name: "Intake",
					forms: [
						{
							name: "Register",
							type: "survey",
							fields: [f({ kind: "text", id: "q1", label: proseText("Q") })],
						},
					],
				},
				{
					name: "Followup",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [f({ kind: "text", id: "q2", label: proseText("Q") })],
						},
					],
				},
			],
		});
		const [m1, m2] = doc.moduleOrder;
		const f1 = doc.formOrder[m1][0]; // Register, in Intake
		const f2 = doc.formOrder[m2][0]; // Visit, in Followup

		// Register links to the Visit form in the OTHER module (by uuid).
		const linked = produce(doc, (d) => {
			d.forms[f1].formLinks = [
				{
					uuid: testUuid("lnk-register-visit"),
					target: { type: "form", moduleUuid: m2, formUuid: f2 },
				},
			];
		});
		// Before any reorder, Followup is display-index 1.
		expect(firstFormLinkTarget(expandDoc(admitted(linked)))).toEqual({
			moduleIndex: 1,
			formIndex: 0,
		});

		// Move Followup (m2) to the FRONT.
		const reordered = produce(linked, (d) => {
			applyMutations(
				d,
				admitMutationBatch([{ kind: "moveModule", uuid: m2, after: null }]),
			);
		});
		expect(reordered.moduleOrder).toEqual([m2, m1]);

		// The link target follows the move to index 0 — an emitter resolving the
		// reference against a stale sequence would emit slot 1 (Intake's own
		// menu), navigating wrong.
		expect(firstFormLinkTarget(expandDoc(admitted(reordered)))).toEqual({
			moduleIndex: 0,
			formIndex: 0,
		});
	});
});
