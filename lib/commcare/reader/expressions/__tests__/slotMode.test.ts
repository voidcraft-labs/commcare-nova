/**
 * The reader prints a slot as the production emitter does: the text
 * `expandDoc` writes into an HQ JSON slot is the reader's own print of the
 * stored tree in `slotReadMode`'s mode, so a slot printed under another
 * interpolation, or through another build context, differs here. The
 * literals hold the text HQ's build replaces, which the printer splits.
 */
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { expandDoc } from "@/lib/commcare/expander";
import type { Expression, SlotContextRef } from "@/lib/domain/expression/types";
import { printSlot, slotReadMode } from "../readExpression";
import { readEnv } from "./expressionReadFixture";

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
