/**
 * The key-order sub-step narrator: advisory by contract: a hit yields the
 * honest label, a miss degrades to nothing, and nothing it does can
 * corrupt state. Strict-mode constrained decoding pins property order to
 * schema order, which is what makes watching for top-level keys truthful.
 */

import { describe, expect, it } from "vitest";
import {
	CONTRACT_STEP_LABELS,
	createSubmissionStepNarrator,
} from "@/lib/agent/build/progress";

describe("createSubmissionStepNarrator", () => {
	it("names each step as its key streams, in order", () => {
		const narrator = createSubmissionStepNarrator(CONTRACT_STEP_LABELS);
		expect(narrator.feed('{"schemaVersion":1,"charter":{')).toBe(
			"Setting the app direction",
		);
		expect(narrator.feed('},"actors":[],"records":[{"name"')).toBe(
			"Working out the records",
		);
		expect(narrator.feed('}],"workflows":[')).toBe("Shaping the workflows");
	});

	it("survives a key split across two deltas", () => {
		const narrator = createSubmissionStepNarrator(CONTRACT_STEP_LABELS);
		expect(narrator.feed('{"rec')).toBeUndefined();
		expect(narrator.feed('ords":[')).toBe("Working out the records");
	});

	it("reports the latest key when several land in one delta", () => {
		const narrator = createSubmissionStepNarrator(CONTRACT_STEP_LABELS);
		expect(narrator.feed('{"actors":[],"records":[],"workflows":[')).toBe(
			"Shaping the workflows",
		);
	});

	it("degrades to the last known step on unknown keys", () => {
		const narrator = createSubmissionStepNarrator(CONTRACT_STEP_LABELS);
		expect(narrator.feed('{"unknownKey":1')).toBeUndefined();
		expect(narrator.feed(',"charter":{')).toBe("Setting the app direction");
		expect(narrator.feed(',"anotherUnknown":2')).toBe(
			"Setting the app direction",
		);
	});
});
