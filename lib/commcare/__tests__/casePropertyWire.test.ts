import { describe, expect, it } from "vitest";
import { emitCasePropertyWirePath } from "../casePropertyWire";

// Core CaseChildElement exposes case identity/type/owner/status as attributes.
// external_id is also copied from Case.data into a child by setCaseProperties;
// ordinary properties, including prototype-like names, remain child reads.
describe("emitCasePropertyWirePath", () => {
	it.each([
		["case_name", "case_name"],
		["external_id", "external_id"],
		["date_opened", "date_opened"],
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
