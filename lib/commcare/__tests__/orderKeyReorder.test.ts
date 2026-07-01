/**
 * Order-key reorder — the WIRE reflects a granular `moveField` / `moveOption`
 * / `moveColumn`, and colliding order keys resolve deterministically.
 *
 * This is the behavioral guard the review asked for: it exercises the full
 * path (mutation → doc → wire emitter) so a consumer that read a membership
 * array's POSITION instead of the `sort-by-(order, uuid)` sequence would fail
 * here, not in prod. A same-parent reorder writes only the entity's `order` and
 * leaves the membership array untouched, so array-position emission would be
 * stale.
 */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { HqApplication, HqFormLink } from "@/lib/commcare";
import { expandDoc } from "@/lib/commcare/expander";
import { applyMutations } from "@/lib/doc/mutations";
import {
	backfillOptionUuids,
	backfillOrderKeys,
} from "@/lib/doc/order/backfill";
import { bySortKey } from "@/lib/doc/order/compare";
import { keyBetween } from "@/lib/doc/order/keys";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, FormLink, Uuid } from "@/lib/domain";
import { asUuid, plainColumn } from "@/lib/domain";

/** The first form's XForm attachment, as a string. */
function firstFormXml(doc: BlueprintDoc): string {
	const attachments = expandDoc(doc)._attachments;
	const key = Object.keys(attachments).find((k) => k.endsWith(".xml"));
	if (key === undefined) throw new Error("no form attachment");
	return attachments[key];
}

/** Positions of each needle in `haystack`, in the order they FIRST appear. */
function firstIndices(haystack: string, needles: string[]): number[] {
	return needles.map((n) => haystack.indexOf(n));
}

/** The `target` of the first emitted `form_links` entry across the app. */
function firstFormLinkTarget(app: HqApplication): HqFormLink["target"] {
	for (const module of app.modules) {
		for (const form of module.forms) {
			if (form.form_links.length > 0) return form.form_links[0].target;
		}
	}
	throw new Error("no form_links emitted");
}

function hydrate(doc: BlueprintDoc): BlueprintDoc {
	const copy = structuredClone(doc);
	backfillOrderKeys(copy);
	backfillOptionUuids(copy);
	return copy;
}

describe("order-key reorder reflects on the wire", () => {
	it("a same-parent moveField re-sequences the emitted XForm binds", () => {
		const doc = hydrate(
			buildDoc({
				modules: [
					{
						name: "M",
						forms: [
							{
								name: "F",
								type: "survey",
								fields: [
									f({ kind: "text", id: "qa", label: "A" }),
									f({ kind: "text", id: "qb", label: "B" }),
									f({ kind: "text", id: "qc", label: "C" }),
								],
							},
						],
					},
				],
			}),
		);
		const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
		const [ua, , uc] = doc.fieldOrder[formUuid];
		// Move qc to the FRONT: order before qa. The membership array is left
		// untouched — only qc's `order` changes.
		const next = produce(doc, (d) => {
			applyMutations(d, [
				{
					kind: "moveField",
					uuid: uc,
					toParentUuid: formUuid,
					order: keyBetween(null, d.fields[ua].order ?? null),
				} as Mutation,
			]);
		});
		// Membership array unchanged; display order is qc, qa, qb.
		expect(next.fieldOrder[formUuid]).toEqual(doc.fieldOrder[formUuid]);
		const xml = firstFormXml(next);
		const [ia, ib, ic] = firstIndices(xml, [
			'nodeset="/data/qa"',
			'nodeset="/data/qb"',
			'nodeset="/data/qc"',
		]);
		// qc's bind emits FIRST, then qa, then qb.
		expect(ic).toBeGreaterThanOrEqual(0);
		expect(ic).toBeLessThan(ia);
		expect(ia).toBeLessThan(ib);
	});

	it("a moveOption re-sequences the emitted select items", () => {
		const doc = hydrate(
			buildDoc({
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
										label: "Color",
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
			}),
		);
		const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
		const fieldUuid = doc.fieldOrder[formUuid][0];
		const field = doc.fields[fieldUuid] as { options: { uuid?: Uuid }[] };
		const blueUuid = field.options[2].uuid as Uuid;
		// Move "blue" to the FRONT (order before red).
		const redOrder = (field.options[0] as { order?: string }).order ?? null;
		const next = produce(doc, (d) => {
			applyMutations(d, [
				{
					kind: "moveOption",
					fieldUuid,
					uuid: blueUuid,
					order: keyBetween(null, redOrder),
				} as Mutation,
			]);
		});
		const xml = firstFormXml(next);
		const [iRed, iGreen, iBlue] = firstIndices(xml, [
			"<value>red</value>",
			"<value>green</value>",
			"<value>blue</value>",
		]);
		expect(iBlue).toBeGreaterThanOrEqual(0);
		expect(iBlue).toBeLessThan(iRed);
		expect(iRed).toBeLessThan(iGreen);
	});

	it("a moveColumn re-sequences the emitted case-list detail columns", () => {
		const c1 = asUuid("col-1");
		const c2 = asUuid("col-2");
		const doc = hydrate(
			buildDoc({
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
							searchInputs: [],
						},
					},
				],
			}),
		);
		const moduleUuid = doc.moduleOrder[0];
		// Move "Age" (col-2) before "Name" (col-1).
		const nameOrder =
			doc.modules[moduleUuid].caseListConfig?.columns.find((c) => c.uuid === c1)
				?.order ?? null;
		const next = produce(doc, (d) => {
			applyMutations(d, [
				{
					kind: "moveColumn",
					moduleUuid,
					uuid: c2,
					order: keyBetween(null, nameOrder),
				} as Mutation,
			]);
		});
		const hqMod = expandDoc(next).modules[0];
		const headers = hqMod.case_details.short.columns.map(
			(col) => col.header.en,
		);
		// "Age" now precedes "Name" on the wire.
		expect(headers.indexOf("Age")).toBeLessThan(headers.indexOf("Name"));
	});

	it("colliding order keys resolve deterministically (uuid tie-break) and the wire agrees", () => {
		const doc = hydrate(
			buildDoc({
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
										id: "pick",
										label: "Pick",
										options: [{ value: "x", label: "X" }],
									}),
								],
							},
						],
					},
				],
			}),
		);
		const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
		const fieldUuid = doc.fieldOrder[formUuid][0];
		// Two concurrent `addOption`s land the SAME order key (both computed
		// "append after the single existing option" against the same base doc).
		const existing = doc.fields[fieldUuid] as { options: { order?: string }[] };
		const collidingKey = keyBetween(existing.options[0].order ?? null, null);
		const optA = asUuid("opt-aaa");
		const optB = asUuid("opt-bbb");
		const next = produce(doc, (d) => {
			applyMutations(d, [
				{
					kind: "addOption",
					fieldUuid,
					option: {
						value: "a",
						label: "A",
						uuid: optA,
						order: collidingKey,
					},
				} as Mutation,
				{
					kind: "addOption",
					fieldUuid,
					option: {
						value: "b",
						label: "B",
						uuid: optB,
						order: collidingKey,
					},
				} as Mutation,
			]);
		});
		// bySortKey tie-breaks on uuid: "opt-aaa" < "opt-bbb", so A precedes B —
		// deterministic regardless of which member's add applied first.
		const opts = (next.fields[fieldUuid] as { options: { uuid?: Uuid }[] })
			.options;
		const displayUuids = [...opts].sort(bySortKey).map((o) => o.uuid);
		expect(displayUuids.indexOf(optA)).toBeLessThan(displayUuids.indexOf(optB));
		// The wire emits A before B (same tie-break the display uses).
		const xml = firstFormXml(next);
		expect(xml.indexOf("<value>a</value>")).toBeLessThan(
			xml.indexOf("<value>b</value>"),
		);
	});

	it("a form_links target survives a module reorder (points at the display-moved menu)", () => {
		const doc = hydrate(
			buildDoc({
				modules: [
					{
						name: "Intake",
						forms: [
							{
								name: "Register",
								type: "survey",
								fields: [f({ kind: "text", id: "q1", label: "Q" })],
							},
						],
					},
					{
						name: "Followup",
						forms: [
							{
								name: "Visit",
								type: "survey",
								fields: [f({ kind: "text", id: "q2", label: "Q" })],
							},
						],
					},
				],
			}),
		);
		const [m1, m2] = doc.moduleOrder;
		const f1 = doc.formOrder[m1][0]; // Register, in Intake
		const f2 = doc.formOrder[m2][0]; // Visit, in Followup

		// Register links to the Visit form in the OTHER module (by uuid).
		const linked = produce(doc, (d) => {
			d.forms[f1].formLinks = [
				{ target: { type: "form", moduleUuid: m2, formUuid: f2 } },
			] as FormLink[];
		});
		// Before any reorder, Followup is display-index 1.
		expect(firstFormLinkTarget(expandDoc(linked))).toEqual({
			type: "form",
			moduleIndex: 1,
			formIndex: 0,
		});

		// Move Followup (m2) to the FRONT: only m2's `order` changes; the
		// moduleOrder membership array is left untouched.
		const reordered = produce(linked, (d) => {
			applyMutations(d, [
				{
					kind: "moveModule",
					uuid: m2,
					order: keyBetween(null, d.modules[m1].order ?? null),
				} as Mutation,
			]);
		});
		expect(reordered.moduleOrder).toEqual(linked.moduleOrder);

		// The link target follows the DISPLAY move to index 0 — a raw array read
		// would emit the stale slot 1 (Intake's own menu), navigating wrong.
		expect(firstFormLinkTarget(expandDoc(reordered))).toEqual({
			type: "form",
			moduleIndex: 0,
			formIndex: 0,
		});
	});
});
