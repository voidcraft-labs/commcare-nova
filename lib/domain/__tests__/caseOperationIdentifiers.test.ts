/**
 * The own case operation's birth id. It becomes an XForm element name, so an
 * id that kept a case type's `-`, or collided with another operation of the
 * form, would name an element HQ cannot build or two blocks at one path.
 */
import { describe, expect, it } from "vitest";
import {
	isCaseOperationIdentifier,
	ownCaseOperationId,
} from "@/lib/domain/caseOperationIdentifiers";

describe("ownCaseOperationId", () => {
	it("is the module's case type when it is free", () => {
		expect(ownCaseOperationId("patient", new Set())).toBe("patient");
	});

	it("turns characters the identifier grammar refuses into underscores", () => {
		const id = ownCaseOperationId("home-visit", new Set());
		expect(id).toBe("home_visit");
		expect(isCaseOperationIdentifier(id)).toBe(true);
	});

	it("steps past the form's other operation ids", () => {
		expect(
			ownCaseOperationId("patient", new Set(["patient", "patient_2"])),
		).toBe("patient_3");
	});
});
