import { describe, expect, it } from "vitest";
import { storageValueFromEvaluation } from "../submissionEnvelope";

describe("storageValueFromEvaluation", () => {
	it("recovers a pg date's lexical day from local calendar parts", () => {
		// node-postgres parses a `date` column at LOCAL midnight; reading
		// UTC parts back would shift the stored day for any process zone
		// east of UTC. The local-part read is the timezone-proof inverse.
		const parsedByPg = new Date(2026, 6, 24);
		expect(storageValueFromEvaluation(parsedByPg, "date")).toBe("2026-07-24");
	});

	it("canonicalizes a timestamptz to the stored ISO instant", () => {
		const instant = new Date("2026-07-24T05:12:11.400Z");
		expect(storageValueFromEvaluation(instant, "datetime")).toBe(
			"2026-07-24T05:12:11.400Z",
		);
	});

	it("tags an offset-less pg time for storage, keeping explicit offsets", () => {
		// The wire's time answer is a wall clock with three fractional
		// digits and no zone (`TimeData::uncast`); the `Z` is the tag the
		// strict `format: "time"` schema requires on top of it.
		expect(storageValueFromEvaluation("05:12:11", "time")).toBe(
			"05:12:11.000Z",
		);
		expect(storageValueFromEvaluation("05:12:11+02:00", "time")).toBe(
			"05:12:11.000+02:00",
		);
	});

	it("stamps a naive datetime answer with the submitting viewer's zone", () => {
		// A string (rather than a pg `Date`) is a form answer's wall clock,
		// and the device stamps the zone it was entered in. Without a zone
		// the caller gets the deterministic UTC reading.
		expect(
			storageValueFromEvaluation(
				"2026-07-24T05:12:11",
				"datetime",
				"America/New_York",
			),
		).toBe("2026-07-24T05:12:11.000-04:00");
		expect(storageValueFromEvaluation("2026-07-24T05:12:11", "datetime")).toBe(
			"2026-07-24T05:12:11.000Z",
		);
	});

	it("keeps numerics typed and coerces pg's numeric-string decimals", () => {
		expect(storageValueFromEvaluation(30, "int")).toBe(30);
		expect(storageValueFromEvaluation("2.5", "decimal")).toBe(2.5);
	});

	it("signals blank (SQL NULL, '', empty selection) as undefined for every type", () => {
		// The wire's calculate writes '' for a blank source; Nova's
		// storage projects that state as key-absent, so the executor
		// omits the key on create and removes it on update.
		expect(storageValueFromEvaluation(null, "text")).toBeUndefined();
		expect(storageValueFromEvaluation("", "text")).toBeUndefined();
		expect(storageValueFromEvaluation(null, "int")).toBeUndefined();
		expect(storageValueFromEvaluation(null, "date")).toBeUndefined();
		expect(storageValueFromEvaluation([], "multi_select")).toBeUndefined();
		expect(storageValueFromEvaluation(null, "single_select")).toBeUndefined();
	});

	it("keeps a multi-select array and space-joins one aimed at text", () => {
		expect(storageValueFromEvaluation(["a", "b"], "multi_select")).toEqual([
			"a",
			"b",
		]);
		// The XForms wire convention for a selection's string projection.
		expect(storageValueFromEvaluation(["a", "b"], "text")).toBe("a b");
	});
});
