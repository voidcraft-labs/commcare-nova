// The shapes the form path emits, run through the REAL validator the case
// store compiles for a temporal property — the check #275 asked for.
//
// The bug that issue reports was never a validator disagreement: it was the
// preview form handing the write path a value the write path had always
// been going to reject. Asserting the transformation in isolation would
// have missed it just as easily, because the transformation looked right.
// So this file builds ajv exactly as `PostgresCaseStore` does
// (`buildAjv` — `Ajv2020` + `addFormats`, over `schemaForDataType`) and
// feeds it the output of the functions the form path actually calls.

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import type { CasePropertyDataType } from "@/lib/domain";
import { DATE_DATA_TYPES } from "@/lib/domain";
import { schemaForDataType } from "@/lib/domain/predicate/jsonSchema";
import {
	storageDatetimeValue,
	storageTimeValue,
} from "@/lib/domain/temporalValues";
import { NAIVE_TEMPORAL_TEXT_RE } from "../../sql/dataTypeTokens";

/** Built the way `PostgresCaseStore.buildAjv` builds it, so a strictness
 *  or format-package change reaches this suite too. */
function validatorFor(dataType: CasePropertyDataType): ValidateFunction {
	const ajv = new Ajv2020({ strict: false });
	addFormats(ajv);
	return ajv.compile(schemaForDataType(dataType));
}

const timeSchema = validatorFor("time");
const datetimeSchema = validatorFor("datetime");
const dateSchema = validatorFor("date");

describe("temporal storage shapes clear the row schema", () => {
	it("accepts every clock a person can enter, once tagged for storage", () => {
		for (const entered of [
			"14:30",
			"14:30:05",
			"09:05:00.000",
			"00:00:00.000",
			"23:59:59.999",
		]) {
			const stored = storageTimeValue(entered);
			expect(
				timeSchema(stored),
				`${entered} -> ${stored} was rejected by format: "time"`,
			).toBe(true);
		}
	});

	it("accepts a datetime stamped in a zone on either side of DST", () => {
		for (const zone of ["UTC", "America/New_York", "Asia/Kolkata"]) {
			for (const entered of [
				"2026-01-15T10:00",
				"2026-07-15T10:00:00",
				"2026-07-15T10:00:00.500",
			]) {
				const stored = storageDatetimeValue(entered, zone);
				expect(
					datetimeSchema(stored),
					`${entered} in ${zone} -> ${stored} was rejected by format: "date-time"`,
				).toBe(true);
			}
		}
	});

	it("accepts the calendar date the picker emits, unchanged", () => {
		expect(dateSchema("2026-01-15")).toBe(true);
	});

	it("still rejects the naive shapes — which is why the tag exists", () => {
		// The premise of the whole design. If either of these ever passes,
		// Nova can store CommCare's own spelling and the `Z` tag (plus the
		// preload strip that undoes it) can go.
		expect(timeSchema("14:30:00.000")).toBe(false);
		expect(datetimeSchema("2026-01-15T10:00:00.000")).toBe(false);
	});

	// The `Z` on a stored time is a tag on a wall clock, and it stays
	// harmless only because nothing reads a bare time as an instant. Both
	// gates below are true today by construction rather than by intent, so
	// they are asserted here: widening either one turns every stored wall
	// clock into a moment offset by the viewer's zone, silently and
	// everywhere at once.
	describe("the time storage tag stays a tag", () => {
		it("keeps time out of the viewer-local format-date renderer", () => {
			expect(DATE_DATA_TYPES.has("time")).toBe(false);
			// The set is still the one format-date's gate reads, and it does
			// hold the kinds that legitimately render.
			expect(DATE_DATA_TYPES.has("date")).toBe(true);
			expect(DATE_DATA_TYPES.has("datetime")).toBe(true);
		});

		it("keeps a bare time out of the naive-shape zone pinning", () => {
			// `compilePinnedInstant` reads a NAIVE match as viewer wall time.
			// A time-of-day must never match, or the tag becomes an instant.
			expect(NAIVE_TEMPORAL_TEXT_RE.test("14:30:00.000")).toBe(false);
			expect(NAIVE_TEMPORAL_TEXT_RE.test("14:30")).toBe(false);
			// The shapes it SHOULD match, so this isn't passing vacuously.
			expect(NAIVE_TEMPORAL_TEXT_RE.test("2026-01-15")).toBe(true);
			expect(NAIVE_TEMPORAL_TEXT_RE.test("2026-01-15T10:00:00")).toBe(true);
		});
	});

	it("preserves the instant a stamped datetime denotes", () => {
		// The shape passing is necessary but not sufficient: a value that
		// validates can still mean the wrong moment. 10:00 entered in New
		// York in January is 15:00 UTC, and nothing downstream re-reads the
		// wall clock in a different zone.
		const stored = storageDatetimeValue("2026-01-15T10:00", "America/New_York");
		expect(new Date(stored).toISOString()).toBe("2026-01-15T15:00:00.000Z");
	});
});
