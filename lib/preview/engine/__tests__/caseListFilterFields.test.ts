// What a device's entity holds for a calculated value and a property, the
// path it holds for an uploaded image, and which order terms tie as the case
// store compares them: the pure pieces the list filter reads its fields and
// its ties through.

import { describe, expect, it } from "vitest";
import { caseListRawText } from "@/lib/preview/columnDisplay";
import type { CaseRowWithCalculated } from "@/lib/preview/engine/caseDataBindingTypes";
import {
	calculatedDeviceText,
	mediaImageReference,
	orderTermsTie,
} from "@/lib/preview/engine/caseListFilterFields";

describe("a calculated value as a device's entity holds it", () => {
	it("is XPath's string of a yes/no, never the cell's Yes or No", () => {
		expect(calculatedDeviceText(true, undefined)).toBe("true");
		expect(calculatedDeviceText(false, undefined)).toBe("false");
	});

	it("is a number as Core prints a Double", () => {
		expect(calculatedDeviceText(3, undefined)).toBe("3");
		expect(calculatedDeviceText(2.5, undefined)).toBe("2.5");
		expect(calculatedDeviceText(0, undefined)).toBe("0");
	});

	it("is the ISO day of a date, and the day of a date and time's moment", () => {
		expect(
			calculatedDeviceText(new Date("2026-05-06T00:00:00.000Z"), "date"),
		).toBe("2026-05-06");
		const moment = new Date("2026-05-06T12:00:00.000Z");
		const local = `${moment.getFullYear()}-${String(moment.getMonth() + 1).padStart(2, "0")}-${String(moment.getDate()).padStart(2, "0")}`;
		expect(calculatedDeviceText(moment, "datetime")).toBe(local);
	});

	it("is blank where Preview holds no value", () => {
		expect(calculatedDeviceText(null, undefined)).toBe("");
		expect(calculatedDeviceText(undefined, undefined)).toBe("");
	});
});

describe("a property as a device holds it", () => {
	it("joins a multi select's tokens with one space, never as JSON", () => {
		const row = {
			case_id: "a",
			case_type: "client",
			case_name: "Amina",
			app_id: "app",
			owner_id: "worker",
			status: "open",
			opened_on: null,
			modified_on: null,
			closed_on: null,
			external_id: null,
			parent_case_id: null,
			properties: { tags: ["vip", "follow_up"] },
			calculated: {},
		} as CaseRowWithCalculated;
		expect(caseListRawText(row, "tags")).toBe("vip follow_up");
		expect(caseListRawText(row, "missing")).toBe("");
	});
});

describe("an uploaded image's path", () => {
	it("names the file by its content hash and extension under jr://file/commcare/", () => {
		expect(
			mediaImageReference({ contentHash: "ab12", extension: ".png" }),
		).toBe("jr://file/commcare/ab12.png");
	});
});

describe("order terms that tie", () => {
	const ties = (
		comparator: "text" | "integer" | "decimal",
		a: string,
		b: string,
	) => orderTermsTie([{ text: a, comparator }], [{ text: b, comparator }]);

	it("compares text with case ignored", () => {
		expect(ties("text", "Kano", "kano")).toBe(true);
		expect(ties("text", "Kano", "Kanoo")).toBe(false);
	});

	it("ties a blank only with a blank", () => {
		expect(ties("text", "", "")).toBe(true);
		expect(ties("integer", "", "0")).toBe(false);
		expect(ties("integer", "", "abc")).toBe(false);
	});

	it("compares whole numbers by their truncated value and their sign", () => {
		expect(ties("integer", "5", "05")).toBe(true);
		expect(ties("integer", "5.7", "5")).toBe(true);
		expect(ties("integer", "-0.5", "0")).toBe(false);
		expect(ties("integer", "-0", "0")).toBe(true);
		expect(ties("integer", " 7 ", "7")).toBe(true);
	});

	it("ties every text that is no number under a numeric comparator", () => {
		expect(ties("integer", "abc", "xyz")).toBe(true);
		expect(ties("decimal", "1e3", "abc")).toBe(true);
		expect(ties("decimal", "1e3", "1000")).toBe(false);
	});

	it("compares decimals by their exact value", () => {
		expect(ties("decimal", "1.50", "1.5")).toBe(true);
		expect(ties("decimal", "-0.0", "0")).toBe(true);
		expect(ties("decimal", "0.1", "0.10000000000000000001")).toBe(false);
	});

	it("needs every term to tie", () => {
		expect(
			orderTermsTie(
				[
					{ text: "Kano", comparator: "text" },
					{ text: "1", comparator: "integer" },
				],
				[
					{ text: "kano", comparator: "text" },
					{ text: "2", comparator: "integer" },
				],
			),
		).toBe(false);
	});
});
