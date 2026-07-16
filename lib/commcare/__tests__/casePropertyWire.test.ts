import { describe, expect, it } from "vitest";
import { emitCasePropertyWirePath } from "../casePropertyWire";

describe("emitCasePropertyWirePath", () => {
	it.each([
		["case_name", "case_name"],
		["name", "case_name"],
		["external_id", "external_id"],
		["external-id", "external_id"],
		["date_opened", "date_opened"],
		["date-opened", "date_opened"],
		["status", "@status"],
		["owner_id", "@owner_id"],
		["case_id", "@case_id"],
		["case_type", "@case_type"],
		["current_status", "current_status"],
		["toString", "toString"],
	])("maps Nova property %s to CommCare leaf %s", (property, expected) => {
		expect(emitCasePropertyWirePath(property)).toBe(expected);
	});
});
