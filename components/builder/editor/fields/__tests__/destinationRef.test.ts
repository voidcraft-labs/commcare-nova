/**
 * destinationRef: the hashtag the Saves to chooser prints for one destination.
 *
 * Pure, and worth its own test because the worker's own record is the one
 * destination whose printed name is NOT its case type. The chooser row and the
 * chosen-state summary both print this; when they each built the string
 * themselves, picking "Cadre" under The worker's own record showed
 * `#user/cadre` in the list and `#commcare-user/cadre` once chosen, which reads
 * as two different places to save.
 */

import { describe, expect, it } from "vitest";
import { USERCASE_CASE_TYPE } from "@/lib/domain";
import { destinationRef } from "../CaseWriteEditor";

describe("destinationRef", () => {
	it("prints an ordinary destination as its own case type", () => {
		expect(destinationRef("patient", "case_name")).toBe("#patient/case_name");
	});

	it("prints the worker's own record as #user/, the namespace that resolves", () => {
		// `lib/commcare/hashtags.ts` maps `#user/` to the commcare-user case;
		// `#commcare-user/` is not a namespace anything reads, and no author
		// is ever asked to name that case type.
		expect(destinationRef(USERCASE_CASE_TYPE, "cadre")).toBe("#user/cadre");
		expect(USERCASE_CASE_TYPE).toBe("commcare-user");
	});
});
