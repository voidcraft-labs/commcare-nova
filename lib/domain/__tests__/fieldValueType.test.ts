/**
 * Bind rule R3: the type a field's bind declares. A visible question binds its
 * kind; a Hidden Value binds the effective type of the property it writes;
 * any other Hidden Value binds a date and time only where its calculate is
 * the clock-keeping date, since Core wraps a `Date` under any other bind as
 * `DateData` and drops its clock (`Recalculate.java::wrapData`).
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { CaseType, Field } from "@/lib/domain";
import {
	clockKeepingJoin,
	INSTANT_TEXT_PATTERN,
} from "@/lib/domain/expression/datePattern";
import type { Expression } from "@/lib/domain/expression/types";
import { fieldValueType } from "@/lib/domain/fieldValueType";
import { proseText } from "@/lib/domain/prose";

const DAY = testUuid("value-type-day");
const CLOCK = testUuid("value-type-clock");
const read = (uuid: typeof DAY): Expression => ({
	kind: "term",
	term: { kind: "field", uuid },
});
const JOIN = clockKeepingJoin(read(DAY), read(CLOCK));
const CATALOG: CaseType[] = [
	{
		name: "visit",
		properties: [
			{ name: "seen_at", label: proseText("Seen"), data_type: "datetime" },
			{ name: "noted", label: proseText("Noted"), data_type: "text" },
			{ name: "untyped", label: proseText("Untyped") },
		],
	},
];
const hidden = (patch: Partial<Extract<Field, { kind: "hidden" }>>): Field => ({
	uuid: testUuid("value-type-hidden"),
	id: "value",
	kind: "hidden",
	...patch,
});

describe("fieldValueType", () => {
	it("binds a visible question by its kind", () => {
		const question: Field = {
			uuid: testUuid("value-type-question"),
			id: "seen",
			kind: "datetime",
			label: proseText("Seen"),
		};
		expect(fieldValueType(question, CATALOG)).toBe("datetime");
	});

	it("binds a Hidden Value by the effective type of the property it writes, whatever its calculate", () => {
		const write = (property: string) => ({ caseType: "visit", property });
		expect(
			fieldValueType(hidden({ caseWrite: write("seen_at") }), CATALOG),
		).toBe("datetime");
		expect(
			fieldValueType(
				hidden({ caseWrite: write("noted"), calculate: JOIN }),
				CATALOG,
			),
		).toBe("text");
	});

	it("binds any other Hidden Value a date and time only where its calculate is the clock-keeping date", () => {
		expect(fieldValueType(hidden({ calculate: JOIN }), CATALOG)).toBe(
			"datetime",
		);
		// A written property with no effective type falls to the same rule.
		expect(
			fieldValueType(
				hidden({
					calculate: JOIN,
					caseWrite: { caseType: "visit", property: "untyped" },
				}),
				CATALOG,
			),
		).toBe("datetime");
		// Instant text without date() is text, and a date of a day is a date:
		// neither is the clock-keeping date, so both keep `xsd:string`.
		const instantText: Expression = {
			kind: "format-date",
			pattern: INSTANT_TEXT_PATTERN,
			date: read(DAY),
		};
		expect(
			fieldValueType(hidden({ calculate: instantText }), CATALOG),
		).toBeUndefined();
		expect(
			fieldValueType(
				hidden({
					calculate: {
						kind: "date-coerce",
						value: { ...instantText, pattern: "%Y-%m-%d" },
					},
				}),
				CATALOG,
			),
		).toBeUndefined();
		expect(fieldValueType(hidden({}), CATALOG)).toBeUndefined();
	});
});
