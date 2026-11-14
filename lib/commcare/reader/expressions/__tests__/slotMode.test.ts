/**
 * The reader prints a slot as the production emitter does: the text
 * `expandDoc` writes into an HQ JSON slot is the reader's own print of the
 * stored tree in `slotReadMode`'s mode, so a slot printed under another
 * interpolation, or through another build context, differs here. The
 * literals hold the text HQ's build replaces, which the printer splits.
 * Over the emitter's own corpora, every interpolating slot's `HqXPath`, as
 * `expandDoc` builds it before printing the application, carries the
 * interpolation `slotReadMode` gives, and its text is the reader's print.
 */
import { describe, expect, it, vi } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { expandDoc } from "@/lib/commcare/expander";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import type { Expression, SlotContextRef } from "@/lib/domain/expression/types";
import type { Uuid } from "@/lib/domain/uuid";
import {
	type HqApplicationTree,
	type HqXPath,
	hqXPathText as hqXPathTextOf,
} from "../../../hqJson/xpath";
import { derivedFormXmlns, derivedUniqueId } from "../../../wireIdentity";
import { printSlot, slotReadMode } from "../readExpression";
import { readEnv } from "./expressionReadFixture";
import { corpusDocs, READ_BACK_CORPORA } from "./readBackCorpus";

/** Each application tree `expandDoc` prints, as it built it. */
const built = vi.hoisted(() => ({ trees: [] as unknown[] }));
vi.mock("../../../hqJson/xpath", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../hqJson/xpath")>();
	return {
		...actual,
		serializeHqApplication: (tree: HqApplicationTree) => {
			built.trees.push(tree);
			return actual.serializeHqApplication(tree);
		},
	};
});

const lit = (value: string): Expression => ({
	kind: "term",
	term: { kind: "literal", value },
});

describe("the reader's print of a slot is the emitter's", () => {
	it("prints menu, form and case list conditions as expandDoc writes them", () => {
		const prop: Expression = {
			kind: "term",
			term: { kind: "prop", caseType: "patient", property: "p" },
		};
		const session: Expression = {
			kind: "term",
			term: { kind: "session-context", field: "username" },
		};
		const doc = buildDoc({
			caseTypes: [{ name: "patient", properties: [{ name: "p", label: "P" }] }],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					displayCondition: { kind: "neq", left: session, right: lit("#user") },
					caseListConfig: {
						columns: [],
						searchInputs: [],
						filter: { kind: "eq", left: prop, right: lit("#case/x") },
					},
					forms: [
						{
							name: "Visit",
							type: "followup",
							displayCondition: {
								kind: "eq",
								left: prop,
								right: lit("#session/x"),
							},
							fields: [f({ kind: "text", id: "q1", label: "Q1" })],
						},
						{
							name: "Survey",
							type: "survey",
							displayCondition: {
								kind: "neq",
								left: session,
								right: lit("#parent"),
							},
							fields: [f({ kind: "text", id: "name", label: "Name" })],
						},
					],
				},
			],
		});
		const app = expandDoc(doc);
		const moduleUuid = doc.moduleOrder[0] as (typeof doc.moduleOrder)[number];
		const mod = doc.modules[moduleUuid];
		const hq = app.modules[0];
		if (mod === undefined || hq === undefined) throw new Error("No menu.");
		const env = readEnv();
		const moduleRef: SlotContextRef = {
			entity: "module",
			uuid: moduleUuid,
			slot: "module_display_condition",
		};
		expect(slotReadMode(doc, moduleRef)).toEqual({
			target: "hq-json",
			interpolation: "no-case",
		});
		expect(
			printSlot(doc, moduleRef, mod.displayCondition as Expression, env),
		).toBe(hq.module_filter);
		const filterRef: SlotContextRef = {
			entity: "module",
			uuid: moduleUuid,
			slot: "case_list_filter",
		};
		expect(
			printSlot(doc, filterRef, mod.caseListConfig?.filter as Expression, env),
		).toBe(hq.case_details.short.filter);
		(doc.formOrder[moduleUuid] ?? []).forEach((formUuid, index) => {
			const form = doc.forms[formUuid];
			const ref: SlotContextRef = {
				entity: "form",
				uuid: formUuid,
				slot: "form_display_condition",
			};
			expect(
				printSlot(doc, ref, form?.displayCondition as Expression, env),
			).toBe(hq.forms[index]?.form_filter);
			expect(slotReadMode(doc, ref)).toEqual({
				target: "hq-json",
				interpolation: form?.type === "followup" ? "case" : "no-case",
			});
		});
	});
});

/** The tree `expandDoc` built for `doc`. */
function treeOf(doc: BlueprintDoc): HqApplicationTree {
	built.trees.length = 0;
	expandDoc(doc);
	const [tree] = built.trees;
	if (tree === undefined) throw new Error("expandDoc printed no application.");
	return tree as HqApplicationTree;
}

describe("the interpolation of every slot of the corpora is the emitter's", () => {
	// Slots held across the corpora; a corpus of field trees holds none.
	let checked = 0;
	for (const corpus of READ_BACK_CORPORA)
		it(`over the ${corpus.name} corpus`, { timeout: 60_000 }, () => {
			for (const doc of corpusDocs(corpus, 8)) {
				const tree = treeOf(doc);
				const env = readEnv();
				const hold = (
					ref: SlotContextRef,
					value: HqXPath | null | undefined,
					stored: Expression | undefined,
				) => {
					if (value === null || value === undefined) return;
					const mode = slotReadMode(doc, ref);
					expect(mode.target, ref.slot).toBe("hq-json");
					if (mode.target !== "hq-json") return;
					expect(value.interpolation, ref.slot).toBe(mode.interpolation);
					checked++;
					if (stored === undefined) return;
					expect(
						printSlot(doc, ref, stored, env),
						`${ref.slot} of ${ref.uuid}`,
					).toBe(
						// The emitter's own text, printed as the application is.
						hqXPathTextOf(value),
					);
				};
				for (const moduleUuid of doc.moduleOrder) {
					const mod = doc.modules[moduleUuid];
					const hq = tree.modules.find(
						(candidate) => candidate.unique_id === derivedUniqueId(moduleUuid),
					);
					if (mod === undefined || hq === undefined) continue;
					hold(
						{
							entity: "module",
							uuid: moduleUuid,
							slot: "module_display_condition",
						},
						hq.module_filter,
						mod.hiddenFromMenu === true ? undefined : mod.displayCondition,
					);
					hold(
						{ entity: "module", uuid: moduleUuid, slot: "case_list_filter" },
						hq.case_details.short.filter,
						undefined,
					);
					for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
						const form = doc.forms[formUuid as Uuid];
						const hqForm = tree.modules
							.flatMap(
								(
									candidate,
								): readonly { xmlns: string; form_filter: HqXPath | null }[] =>
									candidate.forms,
							)
							.find(
								(candidate) =>
									candidate.xmlns === derivedFormXmlns(formUuid as Uuid),
							);
						if (form === undefined || hqForm === undefined) continue;
						hold(
							{
								entity: "form",
								uuid: formUuid as Uuid,
								slot: "form_display_condition",
							},
							hqForm.form_filter,
							form.hiddenFromMenu === true ? undefined : form.displayCondition,
						);
					}
				}
			}
		});
	it("held slots of every interpolation the corpora print", () => {
		expect(checked).toBeGreaterThan(0);
	});
});
