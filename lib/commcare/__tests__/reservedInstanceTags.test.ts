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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	isReservedInstanceTag,
	LOOKUP_WIRE_IDENTIFIER_PATTERN,
	RESERVED_INSTANCE_TAGS,
} from "@/lib/lookup/constants";
import { instanceSourceFor } from "../predicate/instances";

/**
 * The closed set `instanceSourceFor` resolves without a lookup table, READ OUT
 * OF ITS SOURCE rather than restated here.
 *
 * A hand-written copy could not fail: adding a `case "reports":` arm to the
 * emitter would leave every assertion green while reopening exactly the
 * collision this guard closes. Parsing the arms means a new one has to be
 * either unrepresentable as a tag or reserved, or this test goes red.
 */
function emittedInstanceIds(): readonly string[] {
	const source = readFileSync(
		join(process.cwd(), "lib/commcare/predicate/instances.ts"),
		"utf8",
	);
	const start = source.indexOf("export function instanceSourceFor");
	if (start < 0) throw new Error("instanceSourceFor not found");
	// Bound the slice to this function: later helpers in the same file have their
	// own `case` arms over unrelated vocabularies.
	const end = source.indexOf("\nexport ", start + 1);
	const body = source.slice(start, end < 0 ? source.length : end);
	const ids = [...body.matchAll(/case\s+"([^"]+)":/g)].map((m) => m[1]);
	if (ids.length === 0) throw new Error("no instanceSourceFor arms parsed");
	return ids;
}

const EMITTED_INSTANCE_IDS = emittedInstanceIds();

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
		// Parsed from source, so this list grows when the emitter does.
		expect(EMITTED_INSTANCE_IDS.length).toBeGreaterThan(0);
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
