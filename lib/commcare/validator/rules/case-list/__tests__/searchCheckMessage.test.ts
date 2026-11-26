/**
 * Contract: the gate admits a requirement with no message and a check with
 * no message of its own exactly where the wire prints them as CommCare HQ
 * builds them: a requirement has no message or may have its own, never both,
 * and a check can leave the message to the native reader even when the search
 * guards its answers.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { searchGuardedFieldNames } from "@/lib/commcare/suite/case-search/moduleXPathQuery";
import type { SearchInputDef } from "@/lib/domain";
import { eq, input, literal, prop, whenInput } from "@/lib/domain/expression";
import { proseText } from "@/lib/domain/prose";
import {
	admittedCaseListDoc,
	findings,
	withSearchInputs,
} from "./caseListRuleFixture";

const base = () =>
	admittedCaseListDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "region", label: proseText("Region"), data_type: "text" },
					{ name: "status", label: proseText("Status"), data_type: "text" },
				],
			},
		],
	});

const CODE = "CASE_LIST_SEARCH_CHECK_MESSAGE_REFUSED";

const REGION = testUuid("region-field");
const STATUS = testUuid("status-field");

/** A text field over its own property, which CommCare HQ matches by its key: no guard. */
const region = (slots: Partial<SearchInputDef> = {}): SearchInputDef =>
	({
		uuid: REGION,
		name: "region",
		label: "Region",
		kind: "simple",
		type: "text",
		property: "region",
		...slots,
	}) as SearchInputDef;

/** A text field whose condition puts the answer between quotes in the search: guarded. */
const status = (slots: Partial<SearchInputDef> = {}): SearchInputDef =>
	({
		uuid: STATUS,
		name: "status",
		label: "Status",
		kind: "advanced",
		type: "text",
		predicate: whenInput(
			input(STATUS),
			eq(prop("patient", "status"), input(STATUS)),
		),
		...slots,
	}) as SearchInputDef;

function refusals(inputs: SearchInputDef[]) {
	return findings(withSearchInputs(base(), inputs)).filter(
		(error) => error.code === CODE,
	);
}

describe("Search field check messages", () => {
	it("admits a requirement with no message and one with a message of its own", () => {
		expect(refusals([region({ required: { noMessage: true } })])).toEqual([]);
		expect(refusals([region({ required: { message: "Say where" } })])).toEqual(
			[],
		);
	});

	it("refuses a requirement with no message that has a message of its own", () => {
		const found = refusals([
			region({ required: { noMessage: true, message: "Say where" } }),
		]);
		expect(found.map((error) => error.details?.inputName)).toEqual(["region"]);
	});

	it("admits a check with no message on a field the search does not guard", () => {
		const doc = withSearchInputs(base(), [
			region({ validation: { rule: eq(input(REGION), literal("north")) } }),
		]);
		expect(
			searchGuardedFieldNames(doc, doc.moduleOrder[0] as never).has("region"),
		).toBe(false);
		expect(findings(doc).filter((error) => error.code === CODE)).toEqual([]);
	});

	it("admits either an authored message or CommCare's message on a guarded field", () => {
		const doc = withSearchInputs(base(), [
			status({ validation: { rule: eq(input(STATUS), literal("open")) } }),
		]);
		expect(
			searchGuardedFieldNames(doc, doc.moduleOrder[0] as never).has("status"),
		).toBe(true);
		expect(findings(doc).filter((error) => error.code === CODE)).toEqual([]);
		expect(
			refusals([
				status({
					validation: {
						rule: eq(input(STATUS), literal("open")),
						message: "Open or closed",
					},
				}),
			]),
		).toEqual([]);
	});
});
