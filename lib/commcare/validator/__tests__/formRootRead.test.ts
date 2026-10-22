import { describe, expect, it } from "vitest";
import { parseFormExpression } from "@/lib/commcare/xpath/expressionAst";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	formFixture,
	ids,
	requireContext,
} from "@/lib/domain/expression/__tests__/formFixture";
import { typeOf } from "@/lib/domain/expression/typeChecker";
import type {
	Expression,
	ExpressionSlotRef,
} from "@/lib/domain/expression/types";
import {
	formLogicFindings,
	SESSION_FORM_READ_MESSAGE,
} from "../formLogicFindings";
import { runValidation } from "../runner";

const selectedCase = { kind: "selected-case", module: ids.module } as const;
const formCarriers = [
	{ entity: "field", uuid: ids.text, slot: "relevant" },
	{ entity: "field", uuid: ids.text, slot: "validate" },
	{ entity: "field", uuid: ids.hidden, slot: "calculate" },
	{ entity: "field", uuid: ids.text, slot: "default_value" },
	{ entity: "field", uuid: ids.text, slot: "required" },
	{ entity: "field", uuid: ids.repeat, slot: "repeat_count" },
	{ entity: "field", uuid: ids.repeat, slot: "ids_query" },
	{ entity: "form", uuid: ids.form, slot: "assessment_user_score" },
	{ entity: "form", uuid: ids.form, slot: "deliver_entity_id" },
	{ entity: "form", uuid: ids.form, slot: "deliver_entity_name" },
	{
		entity: "form",
		uuid: ids.form,
		slot: "form_link_condition",
		member: { linkUuid: ids.link },
	},
	{
		entity: "form",
		uuid: ids.form,
		slot: "form_link_datum_xpath",
		member: { linkUuid: ids.link, datum: selectedCase },
	},
] satisfies readonly ExpressionSlotRef[];

function carrierFixture(slot: ExpressionSlotRef) {
	const doc = formFixture();
	const literal: Expression = {
		kind: "term",
		term: { kind: "literal", value: 1 },
	};
	if (slot.slot === "repeat_count" || slot.slot === "ids_query") {
		const repeat = doc.fields[ids.repeat];
		if (repeat.kind !== "repeat")
			throw new Error("The repeat fixture is missing.");
		doc.fields[ids.repeat] =
			slot.slot === "repeat_count"
				? { ...repeat, repeat_mode: "count_bound", repeat_count: literal }
				: {
						...repeat,
						repeat_mode: "query_bound",
						data_source: { ids_query: literal },
					};
	} else if (slot.slot === "assessment_user_score") {
		doc.connectType = "learn";
		doc.forms[ids.form].connect = {
			assessment: { id: "quiz", user_score: literal },
		};
	} else if (
		slot.slot === "deliver_entity_id" ||
		slot.slot === "deliver_entity_name"
	) {
		doc.connectType = "deliver";
		doc.forms[ids.form].connect = {
			deliver_unit: {
				id: "visit",
				name: "Visit",
				entity_id: literal,
				entity_name: literal,
			},
		};
	} else if (slot.slot === "form_link_datum_xpath") {
		const link = doc.forms[ids.form].formLinks?.[0];
		if (link === undefined)
			throw new Error("The form link fixture is missing.");
		link.datums = [
			{
				name: selectedCase,
				xpath: {
					kind: "term",
					term: { kind: "session-datum", datum: selectedCase },
				},
			},
		];
	}
	return doc;
}

describe("whole-form reads at every form expression carrier", () => {
	it.each(formCarriers)("refuses bare and nested /data in $slot", (slot) => {
		const doc = carrierFixture(slot);
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const scope = { doc, slot, lookup: new Map() };
		for (const [source, from, to] of [
			["/data", 0, 5],
			["count(/data)", 6, 11],
		] as const) {
			expect(parseFormExpression(source, scope), source).toMatchObject({
				ok: false,
				issues: [{ code: "form-root", from, to }],
			});
		}
		expect(parseFormExpression("'/data'", scope)).toMatchObject({
			ok: true,
			expression: { kind: "term", term: { kind: "literal", value: "/data" } },
		});
	});
});

const root: Expression = {
	kind: "term",
	term: {
		kind: "form-node",
		node: { kind: "form-root", form: ids.form },
		spelling: "relative",
	},
};
describe("the finite form root coordinate", () => {
	it("is typed by its actual form structure while the form is open", () => {
		const ctx = requireContext(formFixture(), {
			entity: "field",
			uuid: ids.hidden,
			slot: "calculate",
		});
		expect(typeOf(root, ctx)?.data).toEqual(
			expect.objectContaining({ container: true }),
		);
		expect(formLogicFindings(root, ctx)).toEqual([]);
	});
	it("cannot read a closed form in a link", () => {
		const ctx = requireContext(formFixture(), {
			entity: "form",
			uuid: ids.form,
			slot: "form_link_condition",
			member: { linkUuid: ids.link },
		});
		expect(formLogicFindings(root, ctx)).toEqual([
			expect.objectContaining({
				code: "INVALID_REF",
				message: SESSION_FORM_READ_MESSAGE,
				checkCode: "form-answer-unavailable",
			}),
		]);
	});
});
