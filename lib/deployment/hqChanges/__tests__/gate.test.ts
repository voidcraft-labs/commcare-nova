/**
 * The gate's refusal of a bring-in lists each thing a person must change once.
 * The failure it catches: two findings whose builder line is one sentence (a
 * slug two pieces of worker information hold, one finding per property)
 * drawn twice in the panel, or the MCP details losing the sentence that names
 * each property.
 */
import { describe, expect, it } from "vitest";
import type { ValidationError } from "@/lib/commcare/validator/errors";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import { hqChangesGateRefusal } from "../gate";

function slugTaken(label: string): ValidationError {
	return {
		code: "USER_PROPERTY_SLUG_DUPLICATE",
		scope: "app",
		message: `${label} saves under the name "village", which is also used by another piece of worker information.`,
		location: {},
		details: { slug: "village" },
	};
}

const caseTypeGone: ValidationError = {
	code: "AUTOMATION_INVALID",
	scope: "app",
	message: "Automation “Close” is not valid.",
	location: {},
};

describe("hqChangesGateRefusal", () => {
	it("draws one builder line for two findings that say one thing, and keeps each finding's own sentence for MCP", () => {
		const first = slugTaken('"village"');
		const second = slugTaken('"Village again"');
		const line = userFacingError(first);
		expect(userFacingError(second)).toBe(line);
		expect(hqChangesGateRefusal([first, second])).toEqual({
			kind: "gate",
			findings: [line],
			details: [first.message, second.message],
		});
	});

	it("keeps distinct lines in the order of their first finding, each line's sentences together", () => {
		const first = slugTaken('"village"');
		const second = slugTaken('"Village again"');
		const refusal = hqChangesGateRefusal([first, caseTypeGone, second]);
		expect(refusal.findings).toEqual([
			userFacingError(first),
			userFacingError(caseTypeGone),
		]);
		expect(refusal.details).toEqual([
			first.message,
			second.message,
			caseTypeGone.message,
		]);
	});

	it("says a finding repeated whole once in both voices", () => {
		const finding = slugTaken('"village"');
		expect(hqChangesGateRefusal([finding, finding])).toEqual({
			kind: "gate",
			findings: [userFacingError(finding)],
			details: [finding.message],
		});
	});
});
