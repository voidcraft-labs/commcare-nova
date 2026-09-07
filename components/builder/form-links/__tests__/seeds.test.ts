// components/builder/form-links/__tests__/seeds.test.ts
//
// Seeds carry placeholder content, never placeholder structure: the
// shapes here are what the add control and the rail land, and
// `formLinkValidByConstruction.test.ts` proves each passes the gate.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { parseXPathForForm } from "@/lib/doc/expressionText";
import type { FormLink } from "@/lib/domain";
import {
	carriedValuesFor,
	retargetDropsCarriedValues,
	retargetLink,
	seedCarriedValues,
	seedConditionalLink,
	seedOtherwiseLink,
} from "../seeds";
import { fixture, SOURCE, toInspect, toNote, toVisit } from "./fixture";

const doc = fixture();
const parse = (text: string) => parseXPathForForm(doc, SOURCE, text);
const required = [{ id: "case_id", caseType: "household" }];

describe("seeds", () => {
	it("a conditional link starts from a condition that never fires", () => {
		const link = seedConditionalLink(
			{ target: toNote, carry: { kind: "nothing-needed" }, required: [] },
			parse,
			testUuid("c"),
		);
		expect(link).toStrictEqual({
			uuid: testUuid("c"),
			condition: parse("false()"),
			target: toNote,
		});
	});

	it("an otherwise link has no condition slot at all", () => {
		const link = seedOtherwiseLink(
			{
				target: toVisit,
				carry: { kind: "automatic", carried: [] },
				required: [],
			},
			parse,
			testUuid("o"),
		);
		expect(link).toStrictEqual({ uuid: testUuid("o"), target: toVisit });
		expect("condition" in link).toBe(false);
		expect("datums" in link).toBe(false);
	});

	it("carries one '' per required value only when the destination needs them by hand", () => {
		expect(
			carriedValuesFor(
				{ kind: "manual-required", datumIds: ["case_id"] },
				required,
				parse,
			),
		).toStrictEqual([{ name: "case_id", xpath: parse("''") }]);
		expect(
			carriedValuesFor({ kind: "automatic", carried: [] }, required, parse),
		).toBeUndefined();
		expect(
			carriedValuesFor({ kind: "nothing-needed" }, [], parse),
		).toBeUndefined();
		expect(seedCarriedValues([], parse)).toStrictEqual([]);
	});

	it("retargeting reseeds values for the destination and reports what it drops", () => {
		const held: FormLink = {
			uuid: testUuid("l"),
			condition: parse("1 = 1"),
			target: toInspect,
			datums: [{ name: "case_id", xpath: parse("#patient/case_id") }],
		};
		const next = retargetLink(
			held,
			{ target: toNote, carry: { kind: "nothing-needed" }, required: [] },
			parse,
		);
		expect(next).toStrictEqual({
			uuid: testUuid("l"),
			condition: parse("1 = 1"),
			target: toNote,
		});
		expect(retargetDropsCarriedValues(held, next)).toBe(true);
		const back = retargetLink(
			next,
			{
				target: toInspect,
				carry: { kind: "manual-required", datumIds: ["case_id"] },
				required,
			},
			parse,
		);
		expect(back.datums).toStrictEqual([
			{ name: "case_id", xpath: parse("''") },
		]);
		expect(retargetDropsCarriedValues(next, back)).toBe(false);
	});
});
