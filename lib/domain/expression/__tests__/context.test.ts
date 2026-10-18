import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	deriveCaseWriteInventory,
	deriveCaseWriteInventoryForStructure,
} from "../../caseWriteInventory";
import { activeRowScope, slotContext } from "../context";
import { formStructure } from "../formStructure";
import {
	checkExpression,
	expressionContextAtPath,
	expressionRowScope,
	typeOf,
} from "../typeChecker";
import type { Expression } from "../types";
import { formFixture, ids, requireContext } from "./formFixture";

describe("an actual expression slot", () => {
	it("exists before optional source is written but requires its owner and member", () => {
		const doc = formFixture();
		expect(
			slotContext(
				doc,
				{ entity: "field", uuid: ids.text, slot: "relevant" },
				new Map(),
			),
		).toBeDefined();
		expect(
			slotContext(
				doc,
				{ entity: "field", uuid: testUuid("missing-field"), slot: "relevant" },
				new Map(),
			),
		).toBeUndefined();
		expect(
			slotContext(
				doc,
				{
					entity: "form",
					uuid: ids.form,
					slot: "form_link_condition",
					member: { linkUuid: testUuid("missing-link") },
				},
				new Map(),
			),
		).toBeUndefined();
	});
	it("rebinds a form predicate's lexical node without replacing its source slot", () => {
		const ctx = requireContext(formFixture(), {
			entity: "field",
			uuid: ids.hidden,
			slot: "calculate",
		});
		const expr: Expression = {
			kind: "term",
			term: {
				kind: "field",
				uuid: ids.inside,
				filters: [
					{
						step: { kind: "field", uuid: ids.repeat },
						where: [{ kind: "term", term: { kind: "literal", value: 1 } }],
					},
				],
			},
		};
		const nested = expressionContextAtPath(expr, ctx, [
			"field",
			"filters",
			0,
			"where",
			0,
		]);
		expect(nested.slot).toBe(ctx.slot);
		expect(nested.sourceNode).toEqual({ kind: "field", uuid: ids.hidden });
		expect(nested.contextNode).toEqual({ kind: "field", uuid: ids.repeat });
		expect(checkExpression(expr, ctx).errors).toEqual([]);
	});
	it("rejects a filter identity moved off its referenced path", () => {
		const ctx = requireContext(formFixture(), {
			entity: "field",
			uuid: ids.hidden,
			slot: "calculate",
		});
		const expr: Expression = {
			kind: "term",
			term: {
				kind: "field",
				uuid: ids.text,
				filters: [
					{
						step: { kind: "field", uuid: ids.repeat },
						where: [{ kind: "match-all" }],
					},
				],
			},
		};
		expect(checkExpression(expr, ctx).errors).toContainEqual(
			expect.objectContaining({
				code: "unknown-form-field",
				reason: "form-filter-step",
				path: ["field", "filters", 0],
			}),
		);
	});
	it("learns a queried row type from an explicit type predicate", () => {
		const ctx = requireContext(formFixture(), {
			entity: "field",
			uuid: ids.hidden,
			slot: "calculate",
		});
		const query: Expression = {
			kind: "cases",
			source: "casedb",
			where: [
				{
					kind: "eq",
					left: { kind: "term", term: { kind: "case-row-type" } },
					right: {
						kind: "term",
						term: { kind: "case-type", caseType: "patient" },
					},
				},
			],
		};
		expect(expressionRowScope(query, ctx)).toEqual({
			kind: "case",
			root: "casedb",
			caseType: "patient",
		});
		const nested = expressionContextAtPath(query, ctx, ["cases", "where", 0]);
		expect(activeRowScope(nested)).toEqual({
			kind: "case",
			root: "casedb",
			caseType: "patient",
		});
		expect(nested.slot).toBe(ctx.slot);
	});
	it("does not infer a query's row type from a property qualifier", () => {
		const ctx = requireContext(formFixture(), {
			entity: "field",
			uuid: ids.hidden,
			slot: "calculate",
		});
		const query: Expression = {
			kind: "cases",
			source: "casedb",
			where: [
				{
					kind: "eq",
					left: {
						kind: "term",
						term: {
							kind: "prop",
							caseType: "patient",
							property: "appointment",
						},
					},
					right: { kind: "term", term: { kind: "literal", value: "12:00" } },
				},
			],
		};
		expect(expressionRowScope(query, ctx)).toEqual({
			kind: "case",
			root: "casedb",
		});
		// The stored custom-property binding belongs to this read; it does not
		// turn an untyped query into a typed row or add a type predicate.
		expect(checkExpression(query, ctx).errors).toEqual([]);
	});
	it("keeps the form's selected record distinct from the row of a case-choice filter", () => {
		const base = formFixture();
		const choice = base.fields[ids.choice];
		if (choice.kind !== "single_select")
			throw new Error("The choice fixture is missing.");
		const filter: Expression = {
			kind: "eq",
			left: {
				kind: "term",
				term: { kind: "prop", caseType: "patient", property: "case_id" },
			},
			right: {
				kind: "term",
				term: { kind: "form-case", caseType: "patient", property: "case_id" },
			},
		};
		const doc = {
			...base,
			fields: {
				...base.fields,
				[ids.choice]: {
					...choice,
					optionsSource: {
						kind: "cases" as const,
						caseType: "patient",
						labelProperty: "case_name",
						filter,
					},
				},
			},
		};
		const choiceContext = requireContext(doc, {
			entity: "field",
			uuid: ids.choice,
			slot: "lookup_options_source",
		});
		expect(checkExpression(filter, choiceContext).errors).toEqual([]);
		const listContext = requireContext(doc, {
			entity: "module",
			uuid: ids.module,
			slot: "case_list_filter",
		});
		expect(checkExpression(filter, listContext).errors).toContainEqual(
			expect.objectContaining({ code: "arm-unavailable", reason: "form-case" }),
		);
	});
	it("keeps a multi-selection out of the scalar session-datum leaf", () => {
		const doc = formFixture();
		const config = doc.modules[ids.module].caseListConfig;
		if (config === undefined)
			throw new Error("The case list fixture is missing.");
		config.selection = { kind: "multiple", maximum: 5 };
		const ctx = requireContext(doc, {
			entity: "field",
			uuid: ids.hidden,
			slot: "calculate",
		});
		expect(
			checkExpression(
				{
					kind: "term",
					term: {
						kind: "session-datum",
						datum: { kind: "selected-case", module: ids.module },
					},
				},
				ctx,
			).errors,
		).toContainEqual(expect.objectContaining({ code: "datum-not-supplied" }));
	});
	it("reads worker properties independently of the worker-record datum", () => {
		const ctx = requireContext(formFixture(), {
			entity: "field",
			uuid: ids.hidden,
			slot: "calculate",
		});
		expect(
			checkExpression(
				{
					kind: "term",
					term: {
						kind: "session-user",
						field: "username",
						source: "worker-record",
					},
				},
				ctx,
			).errors,
		).toEqual([]);
		expect(
			checkExpression(
				{
					kind: "term",
					term: { kind: "session-datum", datum: { kind: "worker-record" } },
				},
				ctx,
			).errors,
		).toContainEqual(
			expect.objectContaining({
				code: "datum-not-supplied",
				reason: "worker-record",
			}),
		);
	});

	it("preserves selected-record identity in inference", () => {
		const ctx = requireContext(formFixture(), {
			entity: "field",
			uuid: ids.hidden,
			slot: "calculate",
		});
		expect(
			typeOf(
				{
					kind: "term",
					term: {
						kind: "session-datum",
						datum: { kind: "selected-case", module: ids.module },
					},
				},
				ctx,
			)?.caseIdOf,
		).toBe("patient");
	});
	it("admits a worker-record source supplied by a writer in the same prepared call", () => {
		const base = formFixture();
		const property = testUuid("pending-worker-property");
		const doc = {
			...base,
			userProperties: {
				[property]: { uuid: property, slug: "visit_note", label: "Visit note" },
			},
			userPropertyOrder: [property],
		};
		const saved = formStructure(doc, ids.form);
		if (saved === undefined) throw new Error("The fixture form is missing.");
		const field = saved.fields.get(ids.text);
		if (field === undefined) throw new Error("The fixture field is missing.");
		const prepared = {
			...saved,
			fields: new Map([
				...saved.fields,
				[
					ids.text,
					{
						...field,
						caseWrite: { caseType: "commcare-user", property: "visit_note" },
					},
				] as const,
			]),
		};
		const slot = {
			entity: "field" as const,
			uuid: ids.hidden,
			slot: "calculate" as const,
		};
		const expression: Expression = {
			kind: "term",
			term: { kind: "session-datum", datum: { kind: "worker-record" } },
		};
		const pending = slotContext(doc, slot, new Map(), { form: prepared });
		if (pending === undefined)
			throw new Error("The prepared fixture slot is missing.");
		expect(checkExpression(expression, pending).errors).toEqual([]);
		expect(
			checkExpression(expression, requireContext(doc, slot)).errors,
		).toContainEqual(expect.objectContaining({ code: "datum-not-supplied" }));
		expect(
			deriveCaseWriteInventoryForStructure(doc, saved, doc.modules[ids.module]),
		).toEqual(
			deriveCaseWriteInventory(
				doc,
				ids.form,
				doc.modules[ids.module],
				doc.forms[ids.form].type,
			),
		);
	});
});
