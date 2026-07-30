// Parity between the instance ids Nova can EMIT and the tags a lookup table may
// not TAKE.
//
// A table's tag is its fixture's instance id on the device, and the runtime
// registers every instance into one map by that id
// (`commcare-core FormDef::addNonMainInstance`, an unconditional put). So a tag
// equal to a runtime-owned id replaces the real instance, and the form silently
// writes nothing. `lib/lookup` owns the refusal in Nova vocabulary; this test is
// the other half — it proves the refusal actually covers everything the emitter
// can produce, so the two lists cannot drift apart.

import { describe, expect, it } from "vitest";
import {
	isReservedInstanceTag,
	LOOKUP_WIRE_IDENTIFIER_PATTERN,
	RESERVED_INSTANCE_TAGS,
} from "@/lib/lookup/constants";
import { instanceSourceFor } from "../predicate/instances";

/**
 * The closed set `instanceSourceFor` resolves without a lookup table — its
 * `switch` arms. Anything outside this set is either a lookup fixture (which is
 * the table's own tag, by construction) or a thrown upstream bug.
 */
const EMITTED_INSTANCE_IDS = [
	"casedb",
	"commcaresession",
	"results",
	"results:inline",
	"search-input:results",
] as const;

describe("reserved instance tags", () => {
	it("covers every non-fixture instance id the emitter can produce", () => {
		for (const id of EMITTED_INSTANCE_IDS) {
			// Either the tag grammar makes the collision unrepresentable, or the
			// reserved list refuses it. One of the two must hold for every id.
			const representableAsTag = LOOKUP_WIRE_IDENTIFIER_PATTERN.test(id);
			expect(
				!representableAsTag || isReservedInstanceTag(id),
				`instance id "${id}" is representable as a tag but not reserved`,
			).toBe(true);
		}
	});

	it("pins the emitter's closed set, so a new arm fails here first", () => {
		for (const id of EMITTED_INSTANCE_IDS) {
			expect(() => instanceSourceFor(id)).not.toThrow();
		}
		expect(() => instanceSourceFor("not-an-instance")).toThrow();
	});

	it("refuses a reserved tag whatever its casing", () => {
		for (const reserved of RESERVED_INSTANCE_TAGS) {
			expect(isReservedInstanceTag(reserved)).toBe(true);
			expect(isReservedInstanceTag(reserved.toUpperCase())).toBe(true);
		}
	});

	it("leaves ordinary tags alone", () => {
		for (const tag of ["regions", "case_types", "districts", "results_2"]) {
			expect(isReservedInstanceTag(tag)).toBe(false);
		}
	});
});
