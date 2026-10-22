import { describe, expect, it } from "vitest";
import {
	dateLiteral,
	datetimeCoerce,
	datetimeLiteral,
	eq,
	input,
	isIn,
	literal,
	neq,
	now,
	prop,
	term,
	whenInput,
} from "@/lib/domain/expression/builders";
import type { Expression } from "@/lib/domain/expression/types";
import { datetimeEquality } from "../../__tests__/csqlCompositionFixture";
import { csqlFixtureContext } from "../../__tests__/csqlFunctionFixture";
import { moduleExpressionContexts } from "../../expressionContext";
import { type CsqlEmissionContext, emitCsql, emitCsqlTree } from "../emitter";

// Finding 75 (06-csql.md §3.13): an equality on a date and time is HQ's closed
// instant range, which HQ answers by instant for every spelling (CI run
// 39315022018); text equality finds none of them. HQ's search over the
// `datetime-equality` scenario holds the meaning; this holds the shape.
const doc = datetimeEquality.doc();
const module = (name: string) => {
	const uuid = doc.moduleOrder.find(
		(entry) => doc.modules[entry].name === name,
	);
	if (uuid === undefined) throw new Error(`No module ${name}`);
	return uuid;
};
const eqNaive = module("eq-naive");
const filter: CsqlEmissionContext = {
	types: moduleExpressionContexts(doc, eqNaive)({ slot: "case_list_filter" }),
};
const opened = module("date_opened-minute");
const openedInput = doc.modules[opened].caseListConfig?.searchInputs[0];
if (openedInput === undefined) throw new Error("No advanced input");
const advanced: CsqlEmissionContext = {
	types: moduleExpressionContexts(
		doc,
		opened,
	)({
		slot: "search_input_predicate",
		member: { searchInputUuid: openedInput.uuid },
	}),
};

const seen = prop("visit", "seen");
const at = term(datetimeLiteral("2026-01-02T04:30:00"));

const range = {
	k: "and",
	items: [
		{ k: "cmp", op: ">=", left: { k: "step", path: ["seen"] } },
		{ k: "cmp", op: "<=", left: { k: "step", path: ["seen"] } },
	],
};

describe("equality on a date and time", () => {
	it("is the closed range for eq, its negation for neq, and an or of ranges for in", () => {
		expect(emitCsqlTree(eq(seen, at), filter)).toMatchObject({
			k: "group",
			item: range,
		});
		expect(emitCsqlTree(neq(seen, at), filter)).toMatchObject({
			k: "not",
			item: range,
		});
		expect(
			emitCsqlTree(
				isIn(
					seen,
					datetimeLiteral("2026-01-02T04:30:00"),
					datetimeLiteral("2026-01-02T05:30:00"),
				),
				filter,
			),
		).toMatchObject({
			k: "group",
			item: {
				k: "or",
				items: [
					{ k: "group", item: range },
					{ k: "group", item: range },
				],
			},
		});
	});

	it("writes a native value HQ evaluates as the bound", () => {
		expect(emitCsqlTree(eq(seen, now()), filter)).toMatchObject({
			k: "group",
			item: {
				k: "and",
				items: [
					{ right: { k: "value-call", fn: "now" } },
					{ right: { k: "value-call", fn: "now" } },
				],
			},
		});
	});

	it("guards a runtime bound against a blank, which HQ's range raises on", () => {
		const answer = input(
			doc.modules[module("eq-runtime")].caseListConfig?.searchInputs[0]?.uuid ??
				("" as never),
		);
		const predicate: Expression = whenInput(
			answer,
			eq(seen, datetimeCoerce(term(answer))),
		);
		const context = {
			types: moduleExpressionContexts(
				doc,
				module("eq-runtime"),
			)({ slot: "case_list_filter" }),
		};
		const kinds = (emitCsql(predicate, context).runtimeRejections ?? []).map(
			(rejection) => rejection.kind,
		);
		expect(kinds).toContain("blank-comparand");
	});

	it("ranges a system date only where no device evaluates the slot", () => {
		const openedAt = eq(
			prop("visit", "date_opened"),
			term(datetimeLiteral("2026-01-02T09:30")),
		);
		expect(emitCsqlTree(openedAt, advanced)).toMatchObject({
			k: "group",
			item: { k: "and", items: [{ op: ">=" }, { op: "<=" }] },
		});
		expect(emitCsqlTree(openedAt, filter)).toMatchObject({ k: "cmp", op: "=" });
	});

	it("leaves a date and a text anchor as equality", () => {
		expect(
			emitCsqlTree(
				eq(prop("visit", "case_name"), term(literal("Amina"))),
				filter,
			),
		).toMatchObject({
			k: "cmp",
			op: "=",
		});
		expect(
			emitCsqlTree(
				eq(prop("patient", "dob"), term(dateLiteral("2020-01-01"))),
				csqlFixtureContext(),
			),
		).toMatchObject({ k: "cmp", op: "=" });
	});
});
