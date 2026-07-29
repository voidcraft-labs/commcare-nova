import { describe, expect, it } from "vitest";
import {
	isReadableTemporalValue,
	paddedTimeOfDay,
	storageDatetimeValue,
	storageTimeValue,
	storedWallClock,
	wireTimeOfDay,
	zoneDesignatorForWallTime,
} from "../temporalValues";

// Every expectation here is a shape one of two authorities produces or
// accepts: JavaRosa's `*Data::uncast` (what a deployed Nova app writes) or
// the strict RFC 3339 formats the case-store schema compiles
// (`propertyToSchema`). The ajv half is proved end to end in
// `lib/case-store/postgres/__tests__/temporalStorageShapes.test.ts`, which
// runs the real validator; this file pins the transformations themselves.

describe("wireTimeOfDay", () => {
	it("pads a bare clock to JavaRosa's HH:MM:SS.mmm", () => {
		// `TimeData::uncast` always writes three fractional digits.
		expect(wireTimeOfDay("14:30")).toBe("14:30:00.000");
		expect(wireTimeOfDay("14:30:05")).toBe("14:30:05.000");
		expect(wireTimeOfDay("9:05")).toBe("09:05:00.000");
	});

	it("normalizes fractional precision to exactly three digits", () => {
		expect(wireTimeOfDay("14:30:05.5")).toBe("14:30:05.500");
		expect(wireTimeOfDay("14:30:05.123456")).toBe("14:30:05.123");
	});

	it("drops a zone designator — the wire's time answer is a wall clock", () => {
		expect(wireTimeOfDay("14:30:05.000Z")).toBe("14:30:05.000");
		expect(wireTimeOfDay("14:30:05-05:00")).toBe("14:30:05.000");
	});

	it("returns an unreadable fragment unchanged for the schema to reject", () => {
		expect(wireTimeOfDay("half past two")).toBe("half past two");
	});
});

describe("storageTimeValue", () => {
	it("tags a wall clock with Z so the strict time schema accepts it", () => {
		expect(storageTimeValue("14:30")).toBe("14:30:00.000Z");
	});

	it("never overrides an offset the value already carried", () => {
		expect(storageTimeValue("14:30:00-05:00")).toBe("14:30:00.000-05:00");
	});

	it("is idempotent — an already-stored time survives a second pass", () => {
		// The form instance holds the stored spelling, so every followup
		// submission re-tags a value that was already tagged. A
		// non-idempotent tag would drift the property on each round trip.
		const once = storageTimeValue("14:30");
		expect(storageTimeValue(once)).toBe(once);
	});

	it("leaves text that is not a time alone instead of mangling it", () => {
		// A bare date reaches here from the `date -> time` migration cast,
		// which slices only at `T`. A zone-designator pattern anchored at
		// the end reads this one's `-15` as an offset and emits
		// `2026-01-15-15`; the cast still fails either way, but the failure
		// reason is quoted back to a person and has to be the real value.
		expect(storageTimeValue("2026-01-15")).toBe("2026-01-15");
		expect(storageTimeValue("half past two")).toBe("half past two");
	});
});

describe("zoneDesignatorForWallTime", () => {
	it("reads the offset in force at that wall clock, not today's", () => {
		// The DST axis: the same zone, opposite sides of the year.
		expect(
			zoneDesignatorForWallTime("2026-01-15T10:00:00.000", "America/New_York"),
		).toBe("-05:00");
		expect(
			zoneDesignatorForWallTime("2026-07-15T10:00:00.000", "America/New_York"),
		).toBe("-04:00");
	});

	it("spells a sub-hour offset with its minutes", () => {
		expect(
			zoneDesignatorForWallTime("2026-01-15T10:00:00.000", "Asia/Kolkata"),
		).toBe("+05:30");
	});

	// The two wall clocks that are not a function of the zone alone: on
	// spring-forward 02:30 never happens, and on fall-back 01:30 happens
	// twice. The two-pass resolution has to answer something, and these pin
	// WHICH something — otherwise the policy is whatever the arithmetic
	// converges on, and nobody finds out it moved.
	//
	// Both answers match `Temporal.PlainDateTime.from(wall)
	// .toZonedDateTime(zone).offset` under its default `compatible`
	// disambiguation, verified against the real implementation. Temporal is
	// ES2026 and the obvious eventual home for this function, but Safari has
	// not shipped it, so adopting it today would mean a polyfill in a leaf
	// module every client bundle imports. Pinning the agreement here is what
	// makes that later swap a provable no-op rather than a behavior change
	// nobody can characterize.
	it("resolves a nonexistent wall clock the way the platform does", () => {
		// 2026-03-08, US spring-forward: 02:00 jumps to 03:00, so 02:30 is
		// not a real local time. Resolving forward into daylight time is
		// `compatible`'s answer.
		expect(
			zoneDesignatorForWallTime("2026-03-08T02:30:00.000", "America/New_York"),
		).toBe("-04:00");
	});

	it("resolves an ambiguous wall clock the way the platform does", () => {
		// 2026-11-01, US fall-back: 01:30 occurs twice. The EARLIER of the
		// two — still daylight time — is `compatible`'s answer.
		expect(
			zoneDesignatorForWallTime("2026-11-01T01:30:00.000", "America/New_York"),
		).toBe("-04:00");
	});

	it("uses Z for a zero offset", () => {
		expect(zoneDesignatorForWallTime("2026-01-15T10:00:00.000", "UTC")).toBe(
			"Z",
		);
	});

	it("falls back to UTC on an unrecognized zone rather than throwing", () => {
		// The zone is client-supplied on the write path; a submission must
		// not die on a bad one.
		expect(
			zoneDesignatorForWallTime("2026-01-15T10:00:00.000", "Not/AZone"),
		).toBe("Z");
	});
});

describe("storageDatetimeValue", () => {
	it("stamps the viewer's own offset, matching what the device writes", () => {
		// `DateTimeData::uncast` writes the wall clock plus the zone the
		// answer was entered in. Preview's author browser stands in for the
		// device, so the same gesture produces the same instant.
		expect(storageDatetimeValue("2026-01-15T10:00", "America/New_York")).toBe(
			"2026-01-15T10:00:00.000-05:00",
		);
	});

	it("keeps an offset the value already carried", () => {
		expect(storageDatetimeValue("2026-01-15T10:00:00.000-05:00", "UTC")).toBe(
			"2026-01-15T10:00:00.000-05:00",
		);
	});

	it("extends a bare date to midnight in the supplied zone", () => {
		expect(storageDatetimeValue("2026-01-15", "UTC")).toBe(
			"2026-01-15T00:00:00.000Z",
		);
		expect(storageDatetimeValue("2026-01-15", "America/New_York")).toBe(
			"2026-01-15T00:00:00.000-05:00",
		);
	});

	it("reads a naive value as UTC when the caller has no viewer", () => {
		// The server-side conversion paths (migration cast, envelope) have
		// no browser to stand in for a device.
		expect(storageDatetimeValue("2026-01-15T10:00:00", "UTC")).toBe(
			"2026-01-15T10:00:00.000Z",
		);
	});

	it("returns an unreadable value unchanged for the schema to reject", () => {
		expect(storageDatetimeValue("sometime tuesday", "UTC")).toBe(
			"sometime tuesday",
		);
	});
});

describe("range checking", () => {
	// A clock the grammar cannot read comes back untouched, which the schema
	// then rejects by name. The alternative — reading it loosely and padding
	// it out — produces `99:00:00.000Z`: canonical-LOOKING text that no
	// validator accepts and no error message can explain.
	it("refuses an impossible clock rather than padding it into shape", () => {
		expect(storageTimeValue("99:00")).toBe("99:00");
		expect(storageTimeValue("14:75")).toBe("14:75");
		expect(storageTimeValue("14:30:99")).toBe("14:30:99");
	});

	it("refuses an impossible calendar month or day", () => {
		expect(storageDatetimeValue("2026-13-01T10:00", "UTC")).toBe(
			"2026-13-01T10:00",
		);
		expect(storageDatetimeValue("2026-01-45T10:00", "UTC")).toBe(
			"2026-01-45T10:00",
		);
	});
});

describe("zone designator spelling", () => {
	// ISO 8601 admits `-05` and `-0530`; RFC 3339 — which is what
	// ajv-formats reads `format: "time"` / `"date-time"` against — admits
	// neither, and both arrive from imported data.
	it("rewrites an ISO-only offset spelling to the RFC 3339 one", () => {
		expect(storageTimeValue("14:30-05")).toBe("14:30:00.000-05:00");
		expect(storageTimeValue("14:30+0530")).toBe("14:30:00.000+05:30");
		expect(storageDatetimeValue("2026-01-15T14:30-05", "UTC")).toBe(
			"2026-01-15T14:30:00.000-05:00",
		);
	});

	it("leaves an already-canonical designator alone", () => {
		expect(storageTimeValue("14:30:00.000Z")).toBe("14:30:00.000Z");
		expect(storageTimeValue("14:30:00.000-05:00")).toBe("14:30:00.000-05:00");
	});
});

describe("isReadableTemporalValue", () => {
	it("accepts everything the canonicalizers produce", () => {
		// The gate and the producers have to agree, or the form engine
		// rejects an answer the case store would have accepted.
		for (const zone of ["UTC", "America/New_York", "Asia/Kolkata"]) {
			for (const time of ["14:30", "9:05:07", "00:00:00.000Z", "14:30-05"]) {
				expect(isReadableTemporalValue("time", storageTimeValue(time))).toBe(
					true,
				);
				expect(
					isReadableTemporalValue(
						"datetime",
						storageDatetimeValue(`2026-07-04T${time}`, zone),
					),
				).toBe(true);
			}
		}
	});

	it("accepts a stored value that predates the millisecond rule", () => {
		// The shape the pre-#376 writer left in rows: RFC 3339, accepted by
		// the schema, not what this module would write today. Asking
		// "already canonical?" here would refuse a person's submission over
		// an answer they never typed and cannot fix.
		expect(isReadableTemporalValue("time", "08:45:00Z")).toBe(true);
		expect(
			isReadableTemporalValue("datetime", "2026-01-15T09:15:00-04:00"),
		).toBe(true);
	});

	it("accepts a bare date in a datetime slot", () => {
		// What a `today()` default puts there. The storage boundary reads it
		// as that date's midnight, exactly as it did before any gate existed.
		expect(isReadableTemporalValue("datetime", "2026-07-28")).toBe(true);
	});

	it("accepts a naive value the storage boundary will stamp", () => {
		expect(isReadableTemporalValue("time", "14:30")).toBe(true);
		expect(isReadableTemporalValue("datetime", "2026-01-15T14:30:00")).toBe(
			true,
		);
	});

	it("turns away only what no canonicalizer could make storable", () => {
		// The reason this is not `canonicalizer(v) === v`: every
		// canonicalizer here is total and returns unreadable text untouched,
		// so that comparison calls "sometime tuesday" a stored time.
		expect(isReadableTemporalValue("time", "sometime tuesday")).toBe(false);
		expect(isReadableTemporalValue("datetime", "sometime tuesday")).toBe(false);
		expect(isReadableTemporalValue("date", "sometime tuesday")).toBe(false);
		expect(isReadableTemporalValue("time", "2:3")).toBe(false);
		expect(isReadableTemporalValue("datetime", "2026-01-15T2:3")).toBe(false);
		expect(isReadableTemporalValue("datetime", "2026-01-15T")).toBe(false);
		expect(isReadableTemporalValue("date", "2026-1-5")).toBe(false);
	});

	it("does not read a bare clock as a datetime", () => {
		expect(isReadableTemporalValue("datetime", "14:30")).toBe(false);
	});
});

describe("storedWallClock", () => {
	it("reads a machine-written clock through its zone designator", () => {
		expect(storedWallClock("14:30:00.000Z")).toBe("14:30:00.000");
		expect(storedWallClock("14:30:00.000-05:00")).toBe("14:30:00.000");
		// Padding is not required — a pre-millisecond row still reads.
		expect(storedWallClock("08:45:00Z")).toBe("08:45:00.000");
	});

	it("reads a padded but zoneless clock — a datetime's own half", () => {
		// A datetime's zone lives on the whole value, so its clock half is
		// zoneless by construction and still machine-written.
		expect(storedWallClock("14:30:00.000")).toBe("14:30:00.000");
	});

	it("refuses text a person could be in the middle of typing", () => {
		// The whole point: "2:30" is readable, but reformatting it to
		// "2:30 AM" would fight someone reaching for PM.
		expect(storedWallClock("2:30")).toBeNull();
		expect(storedWallClock("14:30")).toBeNull();
		expect(storedWallClock("14:30:00")).toBeNull();
		expect(storedWallClock("2:3")).toBeNull();
		expect(storedWallClock("2:30 PM")).toBeNull();
		expect(storedWallClock("")).toBeNull();
	});
});

describe("paddedTimeOfDay", () => {
	it("pads without inventing a zone, and keeps one it was given", () => {
		// The shape a datetime's clock half takes while its date is missing:
		// a `Z` added here would later be mistaken for the whole answer's
		// real offset, and dropping the designator would throw away the zone
		// an existing answer was entered in.
		expect(paddedTimeOfDay("14:30")).toBe("14:30:00.000");
		expect(paddedTimeOfDay("09:15:00.000-04:00")).toBe("09:15:00.000-04:00");
		expect(paddedTimeOfDay("08:45:00Z")).toBe("08:45:00.000Z");
	});

	it("returns unreadable text untouched", () => {
		expect(paddedTimeOfDay("2:3")).toBe("2:3");
	});
});
