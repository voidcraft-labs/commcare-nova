// components/builder/form-links/__tests__/seeds.test.ts
//
// Seeds carry placeholder content, never placeholder structure: the
// shapes here are what the add control and the rail land, and
// `formLinkValidByConstruction.test.ts` proves each passes the gate.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { FormLink } from "@/lib/domain";
import { eq, literal, term } from "@/lib/domain/expression/builders";
import {
	carriedValuesFor,
	retargetDropsCarriedValues,
	retargetLink,
	seedCarriedValues,
	seedConditionalLink,
	seedOtherwiseLink,
} from "../seeds";
import { HOUSEHOLDS, toInspect, toNote, toVisit } from "./fixture";

const datumName = { kind: "selected-case", module: HOUSEHOLDS } as const;
const required = [{ name: datumName, id: "case_id", caseType: "household" }];

describe("seeds", () => {
	it("a conditional link starts from a condition that never fires", () => {
		const link = seedConditionalLink(
			{ target: toNote, carry: { kind: "nothing-needed" }, required: [] },
			testUuid("c"),
		);
		expect(link).toStrictEqual({
			uuid: testUuid("c"),
			condition: { kind: "match-none" },
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
			),
		).toStrictEqual([{ name: datumName, xpath: term(literal("")) }]);
		expect(
			carriedValuesFor({ kind: "automatic", carried: [] }, required),
		).toBeUndefined();
		expect(carriedValuesFor({ kind: "nothing-needed" }, [])).toBeUndefined();
		expect(seedCarriedValues([])).toStrictEqual([]);
	});

	it("retargeting reseeds values for the destination and reports what it drops", () => {
		const held: FormLink = {
			uuid: testUuid("l"),
			condition: eq(literal(1), literal(1)),
			target: toInspect,
			datums: [
				{
					name: datumName,
					xpath: term({
						kind: "form-case",
						caseType: "patient",
						property: "case_id",
					}),
				},
			],
		};
		const next = retargetLink(held, {
			target: toNote,
			carry: { kind: "nothing-needed" },
			required: [],
		});
		expect(next).toStrictEqual({
			uuid: testUuid("l"),
			condition: eq(literal(1), literal(1)),
			target: toNote,
		});
		expect(retargetDropsCarriedValues(held, next)).toBe(true);
		const back = retargetLink(next, {
			target: toInspect,
			carry: { kind: "manual-required", datumIds: ["case_id"] },
			required,
		});
		expect(back.datums).toStrictEqual([
			{ name: datumName, xpath: term(literal("")) },
		]);
		expect(retargetDropsCarriedValues(next, back)).toBe(false);
	});
});
