import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { XPathDate, type XPathValue } from "../../xpath/types";
import {
	type CoreAnswerType,
	castAnswerText,
	coreAnswerType,
	setvalueText,
} from "../answerCast";
import { ANSWER_CAST_ZONE, ANSWER_CASTS } from "./fixtures/answerCasts";

// The rows are Core's outcomes (see the fixture). Node re-reads the zone on
// assignment, and every Date is built after it, since an XPathDate reads its
// calendar day when it is made.
let originalTimeZone: string | undefined;
beforeAll(() => {
	originalTimeZone = process.env.TZ;
	process.env.TZ = ANSWER_CAST_ZONE;
});
afterAll(() => {
	if (originalTimeZone === undefined) delete process.env.TZ;
	else process.env.TZ = originalTimeZone;
});

describe("castAnswerText", () => {
	it.each(ANSWER_CASTS)("casts $type $text as Core does", (row) => {
		const cast = castAnswerText(row.type, row.text, ANSWER_CAST_ZONE);
		if ("refused" in row.expect) expect(cast).toEqual({ ok: false });
		else expect(cast).toEqual({ ok: true, text: row.expect.held });
	});
});

describe("setvalueText", () => {
	/** `Recalculate.wrapData(result, dataType).uncast()`; `undefined` leaves
	 * the node blank. */
	const rows: readonly (readonly [
		XPathValue | (() => XPathValue),
		CoreAnswerType,
		string | undefined,
	])[] = [
		["", "int", undefined],
		[Number.NaN, "text", undefined],
		[true, "text", "1"],
		[false, "int", "0"],
		[true, "date", "1"],
		// An INTEGER node takes IntegerData((int) d): truncated, saturated.
		[1.5, "int", "1"],
		[-1.9, "int", "-1"],
		[Number.POSITIVE_INFINITY, "int", "2147483647"],
		[Number.NEGATIVE_INFINITY, "int", "-2147483648"],
		[-0, "int", "0"],
		// Other nodes: IntegerData within 1e-9 of an int, LongData beyond int,
		// DecimalData's Double.toString otherwise.
		[5, "decimal", "5"],
		[2.0000000001, "text", "2"],
		[1.5, "decimal", "1.5"],
		[3e9, "text", "3000000000"],
		[1e20, "text", "1.0E20"],
		[1e-7, "decimal", "1.0E-7"],
		[Number.POSITIVE_INFINITY, "text", "Infinity"],
		[7, "choice", "7"],
		["a  b", "choice-list", "a  b"],
		["x", "int", "x"],
		// A Date: DateTimeData into a datetime node (its wall clock and the
		// offset at that day's midnight), TimeData into a time node, DateData
		// everywhere else.
		[() => XPathDate.parse("2026-01-05") as XPathDate, "text", "2026-01-05"],
		[() => XPathDate.parse("2026-01-05") as XPathDate, "int", "2026-01-05"],
		[
			() => XPathDate.parse("2026-01-05") as XPathDate,
			"datetime",
			"2026-01-05T00:00:00.000-05",
		],
		[() => XPathDate.parse("2026-01-05") as XPathDate, "time", "00:00:00.000"],
		[
			() => XPathDate.fromInstant(Date.parse("2026-11-01T05:15:00.000Z")),
			"datetime",
			"2026-11-01T01:15:00.000-04",
		],
		[
			() => XPathDate.fromInstant(Date.parse("2026-11-01T05:15:00.000Z")),
			"choice",
			"Sun Nov 01 01:15:00 EDT 2026",
		],
	];
	it.each(rows)("wraps %s for a %s node", (value, type, expected) => {
		const result = typeof value === "function" ? value() : value;
		expect(setvalueText(result, type)).toBe(expected);
	});

	it("casts a now() starting value in a repeated hour to Core's later occurrence", () => {
		// `DateTimeData.uncast` stamps 01:15 EDT with that day's midnight
		// offset, and the cast then resolves 01:15 to EST, an hour later.
		const now = XPathDate.fromInstant(Date.parse("2026-11-01T05:15:00.000Z"));
		const text = setvalueText(now, "datetime");
		expect(text).toBeDefined();
		expect(castAnswerText("datetime", text ?? "", ANSWER_CAST_ZONE)).toEqual({
			ok: true,
			text: "2026-11-01T01:15:00.000-05:00",
		});
	});

	it("refuses a Date written into a whole number", () => {
		const day = XPathDate.parse("2026-01-05") as XPathDate;
		expect(
			castAnswerText("int", setvalueText(day, "int") ?? "", "UTC"),
		).toEqual({ ok: false });
	});
});

describe("coreAnswerType", () => {
	it("reads a select's text bind as a choice and every typed bind as its type", () => {
		expect(coreAnswerType("xsd:string", "single_select")).toBe("choice");
		expect(coreAnswerType("xsd:string", "multi_select")).toBe("choice-list");
		expect(coreAnswerType("xsd:string", "hidden")).toBe("text");
		expect(coreAnswerType("xsd:dateTime", "hidden")).toBe("datetime");
		expect(coreAnswerType("xsd:double", "decimal")).toBe("decimal");
		expect(coreAnswerType("geopoint", "geopoint")).toBe("geopoint");
		expect(coreAnswerType("barcode", "barcode")).toBe("untyped");
		expect(coreAnswerType(null, "group")).toBe("untyped");
	});
});
